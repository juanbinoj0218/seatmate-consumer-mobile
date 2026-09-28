// Customer accounts, shared with the SeatMate website.
//
// This mirrors the website's account-provider.tsx so both read and write the
// exact same data:
//
//   users/{uid}                    displayName, homeZip, recentlyViewed
//   users/{uid}/favorites/{slug}   one document per saved place
//
// A place saved on the website shows up here, and the other way around.

import {
  createContext,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  deleteUser,
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
  signOut as firebaseSignOut,
  User,
} from "firebase/auth";

import {
  arrayRemove,
  arrayUnion,
  collection,
  deleteDoc,
  deleteField,
  doc,
  FieldPath,
  getDocs,
  increment,
  onSnapshot,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
} from "firebase/firestore";

import { auth } from "./auth";
import { db } from "./firebase";
import { getPushToken } from "./notifications";

// -------------------------
// TYPES (same shape as the website)
// -------------------------

export type PlaceSummary = {
  slug: string;
  name: string;
  address: string;
  type: string;
  imageUrl: string;
};

export type SavedPlace = PlaceSummary & {
  savedAtMs: number | null;
};

export type RecentPlace = PlaceSummary & {
  viewedAtMs: number;
};

// "Notify me when a seat opens". Stored on users/{uid} in seatWatches; the
// Cloud Function removes each one once it has sent the notification.
//
// - Whole place:    seatWatches.{slug}
// - One seat:       seatWatches.{slug|tableId|seatId}  (has tableId + seatId)
export type SeatWatch = {
  slug: string;
  businessId: string;
  placeName: string;
  // Group size: only notify when one table has this many free seats
  party: number;
  createdAtMs: number;
  // Only for a specific seat
  tableId?: string;
  tableName?: string;
  seatId?: string;
};

// A watch that hasn't expired yet
function isFreshWatch(watch: SeatWatch | undefined): watch is SeatWatch {
  return !!watch && Date.now() - watch.createdAtMs < SEAT_WATCH_TTL_MS;
}

export function seatWatchId(slug: string, tableId: string, seatId: string | number) {
  return `${slug}|${tableId}|${seatId}`;
}

// Watches expire after 12 hours (same as the website's email alerts)
export const SEAT_WATCH_TTL_MS = 12 * 60 * 60 * 1000;

export type WatchResult =
  | "ok"
  | "signin"
  | "denied"
  | "simulator"
  | "not-configured"
  | "error";

export type Profile = {
  displayName: string;
  homeZip: string;
  recentlyViewed: RecentPlace[];
  seatWatches: Record<string, SeatWatch>;
};

const EMPTY_PROFILE: Profile = {
  displayName: "",
  homeZip: "",
  recentlyViewed: [],
  seatWatches: {},
};

function toSeatWatches(value: unknown): Record<string, SeatWatch> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const watches: Record<string, SeatWatch> = {};

  Object.entries(value as Record<string, Record<string, unknown>>).forEach(([key, watch]) => {
    if (!watch || typeof watch !== "object") {
      return;
    }

    watches[key] = {
      slug: String(watch.slug || key),
      businessId: String(watch.businessId || ""),
      placeName: String(watch.placeName || ""),
      party: Math.max(1, Number(watch.party) || 1),
      createdAtMs: Number(watch.createdAtMs) || 0,
      ...(watch.tableId
        ? {
            tableId: String(watch.tableId),
            tableName: String(watch.tableName || ""),
            seatId: String(watch.seatId ?? ""),
          }
        : {}),
    };
  });

  return watches;
}

const MAX_RECENT = 8;

type AccountContextValue = {
  user: User | null;
  // False until Firebase has told us whether someone is signed in
  authReady: boolean;
  profile: Profile;
  profileReady: boolean;
  favorites: SavedPlace[];
  syncError: string;
  isFavorite: (slug: string) => boolean;
  // Returns false if the person needs to sign in first
  toggleFavorite: (place: PlaceSummary) => Promise<boolean>;
  recordView: (place: PlaceSummary) => Promise<void>;
  clearRecentlyViewed: () => Promise<void>;
  saveProfile: (changes: Partial<Pick<Profile, "displayName" | "homeZip">>) => Promise<void>;
  signOut: () => Promise<void>;
  // True if the account signs in with email + password (needs it to delete)
  usesPassword: boolean;
  // Permanently deletes the account and everything saved under it
  deleteAccount: (password: string) => Promise<void>;
  // "Notify me when a seat opens" (whole place)
  isWatching: (slug: string) => boolean;
  watchSeats: (place: WatchPlace, party: number) => Promise<WatchResult>;
  unwatchSeats: (slug: string, businessId: string) => Promise<void>;
  // "Notify me when this seat opens" (one specific seat)
  isWatchingSeat: (slug: string, tableId: string, seatId: string | number) => boolean;
  watchSeat: (
    place: WatchPlace,
    table: { id: string; name: string },
    seatId: string | number
  ) => Promise<WatchResult>;
  unwatchSeat: (
    slug: string,
    businessId: string,
    tableId: string,
    seatId: string | number
  ) => Promise<void>;
};

type WatchPlace = { slug: string; businessId: string; placeName: string };

const AccountContext = createContext<AccountContextValue | null>(null);

// -------------------------
// HELPERS
// -------------------------

// Same daily stats the website records (publicBusinesses/{slug}/stats/{day})
function dayKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

export function bumpPlaceStat(slug: string, stat: "views" | "saves") {
  if (!slug) {
    return;
  }

  // Fire and forget: stats never block or break the app
  setDoc(
    doc(db, "publicBusinesses", slug, "stats", dayKey()),
    { [stat]: increment(1) },
    { merge: true }
  ).catch(() => {});
}

function describeError(error: unknown, fallback: string) {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";

  if (code === "permission-denied") {
    return "Your account data is blocked by the database's security rules.";
  }

  if (code === "unavailable") {
    return "SeatMate can't reach the database right now. Check your connection.";
  }

  return code ? `${fallback} (${code})` : fallback;
}

function toPlaceSummary(value: Record<string, unknown>): PlaceSummary {
  return {
    slug: String(value.slug || ""),
    name: String(value.name || "SeatMate location"),
    address: String(value.address || ""),
    type: String(value.type || "Restaurant"),
    imageUrl: String(value.imageUrl || ""),
  };
}

// First name for greetings, e.g. "Hi, Maya"
export function firstName(profile: Profile, user: User | null) {
  const name = profile.displayName || user?.displayName || "";
  return name.trim().split(/\s+/)[0] || "";
}

// One letter for the round account button
export function initialFor(profile: Profile, user: User | null) {
  const source = profile.displayName || user?.displayName || user?.email || "";
  return source.trim().charAt(0).toUpperCase() || "S";
}

// -------------------------
// PROVIDER
// -------------------------

export function AccountProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [profile, setProfile] = useState<Profile>(EMPTY_PROFILE);
  const [profileReady, setProfileReady] = useState(false);
  const [favorites, setFavorites] = useState<SavedPlace[]>([]);
  const [syncError, setSyncError] = useState("");

  // Latest profile for callbacks
  const profileRef = useRef(profile);

  // While deleting an account, don't re-create the profile document
  const deletingRef = useRef(false);

  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);

  useEffect(() => {
    let stopProfile: (() => void) | undefined;
    let stopFavorites: (() => void) | undefined;

    const stopAuth = onAuthStateChanged(auth, (nextUser) => {
      stopProfile?.();
      stopFavorites?.();

      setUser(nextUser);
      setAuthReady(true);
      setProfile(EMPTY_PROFILE);
      setProfileReady(false);
      setFavorites([]);
      setSyncError("");

      if (!nextUser) {
        return;
      }

      const userRef = doc(db, "users", nextUser.uid);

      stopProfile = onSnapshot(
        userRef,
        (snapshot) => {
          if (!snapshot.exists() && !deletingRef.current) {
            // First time with this account: create the profile document
            setDoc(
              userRef,
              {
                displayName: nextUser.displayName || "",
                homeZip: "",
                recentlyViewed: [],
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp(),
              },
              { merge: true }
            ).catch((error) => {
              console.error("Could not create SeatMate profile:", error);
              setSyncError(describeError(error, "We couldn't set up your account data."));
            });
          }

          const data = snapshot.data() || {};

          setProfile({
            displayName: String(data.displayName || nextUser.displayName || ""),
            homeZip: String(data.homeZip || ""),
            recentlyViewed: Array.isArray(data.recentlyViewed)
              ? data.recentlyViewed.map((item: Record<string, unknown>) => ({
                  ...toPlaceSummary(item),
                  viewedAtMs: Number(item.viewedAtMs) || 0,
                }))
              : [],
            seatWatches: toSeatWatches(data.seatWatches),
          });

          setProfileReady(true);
        },
        (error) => {
          console.error("Could not load SeatMate profile:", error);
          setSyncError(describeError(error, "We couldn't load your account data."));
          setProfileReady(true);
        }
      );

      stopFavorites = onSnapshot(
        collection(db, "users", nextUser.uid, "favorites"),
        (snapshot) => {
          const saved = snapshot.docs.map((favoriteDoc) => {
            const data = favoriteDoc.data();

            return {
              ...toPlaceSummary({ ...data, slug: favoriteDoc.id }),
              savedAtMs: data.savedAt instanceof Timestamp ? data.savedAt.toMillis() : null,
            };
          });

          // Newest first; ones still being written (no timestamp yet) on top
          saved.sort(
            (a, b) =>
              (b.savedAtMs ?? Number.MAX_SAFE_INTEGER) - (a.savedAtMs ?? Number.MAX_SAFE_INTEGER)
          );

          setFavorites(saved);
        },
        (error) => {
          console.error("Could not load saved places:", error);
          setSyncError(describeError(error, "We couldn't load your saved places."));
        }
      );
    });

    return () => {
      stopAuth();
      stopProfile?.();
      stopFavorites?.();
    };
  }, []);

  const favoriteSlugs = useMemo(
    () => new Set(favorites.map((place) => place.slug)),
    [favorites]
  );

  const isFavorite = useCallback((slug: string) => favoriteSlugs.has(slug), [favoriteSlugs]);

  const toggleFavorite = useCallback(
    async (place: PlaceSummary) => {
      if (!user) {
        return false;
      }

      const favoriteRef = doc(db, "users", user.uid, "favorites", place.slug);

      try {
        if (favoriteSlugs.has(place.slug)) {
          await deleteDoc(favoriteRef);
        } else {
          await setDoc(favoriteRef, { ...place, savedAt: serverTimestamp() });
          bumpPlaceStat(place.slug, "saves");
        }
      } catch (error) {
        console.error("Could not update saved places:", error);
        setSyncError(describeError(error, "We couldn't update your saved places."));
      }

      return true;
    },
    [user, favoriteSlugs]
  );

  const recordView = useCallback(
    async (place: PlaceSummary) => {
      if (!user) {
        return;
      }

      const current = profileRef.current.recentlyViewed;

      // Already the most recent entry; nothing to change
      if (current[0]?.slug === place.slug) {
        return;
      }

      const next = [
        { ...place, viewedAtMs: Date.now() },
        ...current.filter((item) => item.slug !== place.slug),
      ].slice(0, MAX_RECENT);

      try {
        await setDoc(
          doc(db, "users", user.uid),
          { recentlyViewed: next, updatedAt: serverTimestamp() },
          { merge: true }
        );
      } catch (error) {
        console.error("Could not save recently viewed place:", error);
      }
    },
    [user]
  );

  const clearRecentlyViewed = useCallback(async () => {
    if (!user) {
      return;
    }

    await setDoc(
      doc(db, "users", user.uid),
      { recentlyViewed: [], updatedAt: serverTimestamp() },
      { merge: true }
    );
  }, [user]);

  const saveProfile = useCallback(
    async (changes: Partial<Pick<Profile, "displayName" | "homeZip">>) => {
      if (!user) {
        return;
      }

      await setDoc(
        doc(db, "users", user.uid),
        { ...changes, updatedAt: serverTimestamp() },
        { merge: true }
      );
    },
    [user]
  );

  const signOut = useCallback(async () => {
    await firebaseSignOut(auth);
  }, []);

  const isWatching = useCallback(
    (slug: string) => {
      const watch = profile.seatWatches[slug];
      return isFreshWatch(watch) && !watch.tableId;
    },
    [profile.seatWatches]
  );

  const isWatchingSeat = useCallback(
    (slug: string, tableId: string, seatId: string | number) =>
      isFreshWatch(profile.seatWatches[seatWatchId(slug, tableId, seatId)]),
    [profile.seatWatches]
  );

  // Saves one watch (asks for notification permission first)
  const saveWatch = useCallback(
    async (key: string, watch: SeatWatch): Promise<WatchResult> => {
      if (!user) {
        return "signin";
      }

      const push = await getPushToken();

      if (!push.ok) {
        return push.reason;
      }

      try {
        await setDoc(
          doc(db, "users", user.uid),
          {
            pushTokens: arrayUnion(push.token),
            seatWatches: { [key]: watch },
            seatWatchBusinessIds: arrayUnion(watch.businessId),
            updatedAt: serverTimestamp(),
          },
          { merge: true }
        );

        return "ok";
      } catch (error) {
        console.error("Could not save seat alert:", error);
        return "error";
      }
    },
    [user]
  );

  // Removes one watch (and the place from the lookup list if it was the last one)
  const removeWatch = useCallback(
    async (key: string, businessId: string) => {
      if (!user) {
        return;
      }

      const othersForPlace = Object.entries(profile.seatWatches).some(
        ([otherKey, watch]) => otherKey !== key && watch.businessId === businessId
      );

      if (othersForPlace) {
        await updateDoc(
          doc(db, "users", user.uid),
          new FieldPath("seatWatches", key),
          deleteField(),
          "updatedAt",
          serverTimestamp()
        );
      } else {
        await updateDoc(
          doc(db, "users", user.uid),
          new FieldPath("seatWatches", key),
          deleteField(),
          "seatWatchBusinessIds",
          arrayRemove(businessId),
          "updatedAt",
          serverTimestamp()
        );
      }
    },
    [user, profile.seatWatches]
  );

  const watchSeats = useCallback(
    (place: WatchPlace, party: number) =>
      saveWatch(place.slug, {
        slug: place.slug,
        businessId: place.businessId,
        placeName: place.placeName,
        party,
        createdAtMs: Date.now(),
      }),
    [saveWatch]
  );

  const unwatchSeats = useCallback(
    (slug: string, businessId: string) => removeWatch(slug, businessId),
    [removeWatch]
  );

  const watchSeat = useCallback(
    (place: WatchPlace, table: { id: string; name: string }, seatId: string | number) =>
      saveWatch(seatWatchId(place.slug, table.id, seatId), {
        slug: place.slug,
        businessId: place.businessId,
        placeName: place.placeName,
        party: 1,
        createdAtMs: Date.now(),
        tableId: table.id,
        tableName: table.name,
        seatId: String(seatId),
      }),
    [saveWatch]
  );

  const unwatchSeat = useCallback(
    (slug: string, businessId: string, tableId: string, seatId: string | number) =>
      removeWatch(seatWatchId(slug, tableId, seatId), businessId),
    [removeWatch]
  );

  const usesPassword =
    user?.providerData.some((provider) => provider.providerId === "password") ?? false;

  // Apple requires apps with accounts to let people delete them in the app.
  const deleteAccount = useCallback(async (password: string) => {
    const current = auth.currentUser;

    if (!current) {
      return;
    }

    // 1. Confirm it's really them (Firebase requires a recent sign-in)
    const hasPassword = current.providerData.some(
      (provider) => provider.providerId === "password"
    );

    if (hasPassword && current.email) {
      await reauthenticateWithCredential(
        current,
        EmailAuthProvider.credential(current.email, password)
      );
    }

    deletingRef.current = true;

    try {
      const uid = current.uid;

      // 2. Delete saved places
      const favoritesSnapshot = await getDocs(collection(db, "users", uid, "favorites"));

      await Promise.all(favoritesSnapshot.docs.map((favoriteDoc) => deleteDoc(favoriteDoc.ref)));

      // 3. Delete any "tell me when a seat opens" alerts for places they used
      const slugs = new Set([
        ...favoritesSnapshot.docs.map((favoriteDoc) => favoriteDoc.id),
        ...profileRef.current.recentlyViewed.map((place) => place.slug),
      ]);

      await Promise.all(
        Array.from(slugs).map((slug) =>
          deleteDoc(doc(db, "seatAlerts", `${uid}_${slug}`)).catch(() => {})
        )
      );

      // 4. Delete the profile (name, home ZIP, recently viewed)
      await deleteDoc(doc(db, "users", uid));

      // 5. Delete the sign-in account itself
      await deleteUser(current);
    } finally {
      deletingRef.current = false;
    }
  }, []);

  const value = useMemo<AccountContextValue>(
    () => ({
      user,
      authReady,
      profile,
      profileReady,
      favorites,
      syncError,
      isFavorite,
      toggleFavorite,
      recordView,
      clearRecentlyViewed,
      saveProfile,
      signOut,
      usesPassword,
      deleteAccount,
      isWatching,
      watchSeats,
      unwatchSeats,
      isWatchingSeat,
      watchSeat,
      unwatchSeat,
    }),
    [
      user,
      authReady,
      profile,
      profileReady,
      favorites,
      syncError,
      isFavorite,
      toggleFavorite,
      recordView,
      clearRecentlyViewed,
      saveProfile,
      signOut,
      usesPassword,
      deleteAccount,
      isWatching,
      watchSeats,
      unwatchSeats,
      isWatchingSeat,
      watchSeat,
      unwatchSeat,
    ]
  );

  return <AccountContext.Provider value={value}>{children}</AccountContext.Provider>;
}

export function useAccount() {
  const value = useContext(AccountContext);

  if (!value) {
    throw new Error("useAccount must be used inside <AccountProvider>.");
  }

  return value;
}
