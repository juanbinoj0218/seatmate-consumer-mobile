import { ReactNode, useEffect, useRef, useState } from "react";

import {
  ActivityIndicator,
  Image,
  Linking,
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleProp,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  ViewStyle,
} from "react-native";

import { useLocalSearchParams, useRouter } from "expo-router";

import { Ionicons } from "@expo/vector-icons";

import { collection, doc, getDoc, onSnapshot } from "firebase/firestore";

import { bumpPlaceStat, useAccount } from "../../lib/account";
import { SEAT_ALERTS_ENABLED } from "../../lib/features";
import { db } from "../../lib/firebase";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const splashIcon = require("../../../assets/images/splash-icon.png");

// -------------------------
// COLORS (soft, low-contrast palette that's easy on the eyes)
// -------------------------

const C = {
  page: "#F6F6F3",
  card: "#FFFFFF",
  border: "#ECECE8",
  divider: "#F1F1EE",

  text: "#1F2522",
  textSoft: "#5F6763",
  textMuted: "#9AA09D",

  free: "#34A869",
  freeSoft: "#E9F6EE",
  freeText: "#23804F",

  taken: "#E07A7A",
  takenSoft: "#FBEEEE",
  takenText: "#B55353",

  some: "#D9A128",
  someSoft: "#FBF4E3",
  someText: "#9C7318",

  limited: "#E08A4F",
  limitedSoft: "#FCF0E7",
  limitedText: "#A85F2C",

  floor: "#FAFAF8",
  table: "#EDEEEA",
  tableBorder: "#E1E3DE",
  tableText: "#6B726E",

  dark: "#1F2522",
};

// -------------------------
// TYPES
// -------------------------

type Seat = {
  id: string | number;
  status: "available" | "occupied";
};

type TimestampLike = {
  toMillis: () => number;
};

type Table = {
  id: string;
  name: string;
  seats: Seat[];
  xPct: number;
  yPct: number;
  shape: "rectangle" | "round";
  scale: number;
  occupancyUpdatedAt: TimestampLike | null;
};

type MarkerType =
  | "outlet"
  | "window"
  | "register"
  | "counter"
  | "door"
  | "entrance"
  | "restroom"
  | "wall";

type FloorMarker = {
  id: string;
  type: MarkerType;
  label: string;
  xPct: number;
  yPct: number;
  scale: number;
  rotation: number;
};

type PublicBusiness = {
  businessId: string;
  name: string;
  address: string;
  type: string;
  imageUrl: string;
};

type Bounds = {
  minX: number;
  minY: number;
  width: number;
  height: number;
};

// -------------------------
// CONSTANTS
// -------------------------

// The business website places things on a 900 x 620 canvas
const FLOOR_WIDTH = 900;
const FLOOR_HEIGHT = 620;

// Page side padding
const PAGE_PADDING = 16;

// On iPads / big screens, keep the page a comfortable reading width
const MAX_CONTENT_WIDTH = 640;

// Empty space kept around the furniture
const FLOOR_PADDING = 28;

// The floor window never gets taller or shorter than this.
// Zooming only changes what's INSIDE the window.
const MAX_FLOOR_BOX_HEIGHT = 440;
const MIN_FLOOR_BOX_HEIGHT = 180;

// Zoom steps relative to "fit whole floor"
const ZOOM_LEVELS = [1, 1.6, 2.4];

// Show a warning if seats haven't been updated in this many minutes
const STALE_MINUTES = 15;

const MARKERS: Record<
  MarkerType,
  { label: string; icon: string; width: number; height: number }
> = {
  outlet: { label: "Outlet", icon: "⚡", width: 54, height: 54 },
  window: { label: "Window", icon: "", width: 120, height: 36 },
  register: { label: "Register", icon: "▣", width: 92, height: 66 },
  counter: { label: "Counter", icon: "", width: 135, height: 54 },
  door: { label: "Door", icon: "↪", width: 82, height: 42 },
  entrance: { label: "Entrance", icon: "⇥", width: 110, height: 44 },
  restroom: { label: "Restroom", icon: "WC", width: 90, height: 62 },
  wall: { label: "Wall", icon: "", width: 150, height: 26 },
};

const MARKER_LOOK: Record<
  MarkerType,
  { bg: string; border: string; ink: string }
> = {
  wall: { bg: "#DCDDD8", border: "#DCDDD8", ink: "#8A8F8C" },
  window: { bg: "#EAF4FA", border: "#CFE6F3", ink: "#5B8FAD" },
  outlet: { bg: "#FBF6E6", border: "#F0E3B8", ink: "#B08A2E" },
  entrance: { bg: "#EAF6EF", border: "#CDEBD9", ink: "#3D9463" },
  door: { bg: "#EAF6EF", border: "#CDEBD9", ink: "#3D9463" },
  register: { bg: "#F3F3F0", border: "#E6E6E2", ink: "#A2A6A3" },
  counter: { bg: "#F3F3F0", border: "#E6E6E2", ink: "#A2A6A3" },
  restroom: { bg: "#F3F3F0", border: "#E6E6E2", ink: "#A2A6A3" },
};

// -------------------------
// HELPERS
// -------------------------

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

// Same thresholds as the home screen
function getAvailability(available: number, total: number) {
  if (total === 0) {
    return {
      label: "No seating data",
      color: C.textMuted,
      soft: C.divider,
      ink: C.textSoft,
    };
  }

  const pct = (available / total) * 100;

  if (pct >= 60) {
    return {
      label: "Plenty of seating",
      color: C.free,
      soft: C.freeSoft,
      ink: C.freeText,
    };
  }

  if (pct >= 25) {
    return {
      label: "Some seats available",
      color: C.some,
      soft: C.someSoft,
      ink: C.someText,
    };
  }

  if (pct > 0) {
    return {
      label: "Limited seating",
      color: C.limited,
      soft: C.limitedSoft,
      ink: C.limitedText,
    };
  }

  return {
    label: "Currently full",
    color: C.taken,
    soft: C.takenSoft,
    ink: C.takenText,
  };
}

// Table size on the canvas (before zoom)
function getTableBox(table: Table) {
  const isRound = table.shape === "round";

  return {
    width: (isRound ? 175 : 210) * table.scale,
    height: (isRound ? 175 : 165) * table.scale,
  };
}

// The part of the canvas that actually has furniture on it
function getFloorBounds(tables: Table[], markers: FloorMarker[]): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  function include(cx: number, cy: number, halfW: number, halfH: number) {
    minX = Math.min(minX, cx - halfW);
    minY = Math.min(minY, cy - halfH);
    maxX = Math.max(maxX, cx + halfW);
    maxY = Math.max(maxY, cy + halfH);
  }

  tables.forEach((table) => {
    const box = getTableBox(table);

    include(
      (table.xPct / 100) * FLOOR_WIDTH,
      (table.yPct / 100) * FLOOR_HEIGHT,
      box.width / 2,
      box.height / 2,
    );
  });

  markers.forEach((marker) => {
    const info = MARKERS[marker.type];
    const width = info.width * marker.scale;
    const height = info.height * marker.scale;

    // Rotated markers can reach further, so use the longest side
    const rotated = marker.rotation % 180 !== 0;
    const half = Math.max(width, height) / 2;

    include(
      (marker.xPct / 100) * FLOOR_WIDTH,
      (marker.yPct / 100) * FLOOR_HEIGHT,
      rotated ? half : width / 2,
      rotated ? half : height / 2,
    );
  });

  if (minX === Infinity) {
    return { minX: 0, minY: 0, width: FLOOR_WIDTH, height: FLOOR_HEIGHT };
  }

  return {
    minX: minX - FLOOR_PADDING,
    minY: minY - FLOOR_PADDING,
    width: maxX - minX + FLOOR_PADDING * 2,
    height: maxY - minY + FLOOR_PADDING * 2,
  };
}

// -------------------------
// SCREEN
// -------------------------

export default function PlaceScreen() {
  const params = useLocalSearchParams();
  const router = useRouter();
  const { width: screenWidth } = useWindowDimensions();

  const rawSlug = params.slug;

  // Group size picked on the home screen (1 = just me, 4 = 4 or more)
  const partyParam = Number(
    Array.isArray(params.party) ? params.party[0] : params.party,
  );
  const party = Number.isFinite(partyParam)
    ? clamp(Math.round(partyParam), 1, 4)
    : 1;
  const partyLabel = party === 4 ? "4+" : String(party);

  const slug = Array.isArray(rawSlug)
    ? String(rawSlug[0] ?? "")
    : String(rawSlug ?? "");

  const [business, setBusiness] = useState<PublicBusiness | null>(null);
  const [tables, setTables] = useState<Table[]>([]);
  const [markers, setMarkers] = useState<FloorMarker[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState("");

  // Index into ZOOM_LEVELS (0 = whole floor fits)
  const [zoomIndex, setZoomIndex] = useState(0);

  // The table the customer tapped. A seat notification opens its table.
  const [selectedTableId, setSelectedTableId] = useState<string | null>(() => {
    const fromNotification = Array.isArray(params.table) ? params.table[0] : params.table;
    return typeof fromNotification === "string" && fromNotification !== ""
      ? fromNotification
      : null;
  });

  // Floor scrolling (used to keep the same spot in view when zooming)
  const horizontalScrollRef = useRef<ScrollView>(null);
  const verticalScrollRef = useRef<ScrollView>(null);
  const scrollOffset = useRef({ x: 0, y: 0 });
  const zoomFocus = useRef<{ x: number; y: number } | null>(null);

  // Current time, ticking every 30s so "Updated X min ago" stays accurate
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 30000);

    return () => clearInterval(interval);
  }, []);

  // Signed-in customer (same account as the website)
  const {
    user,
    profileReady,
    isFavorite,
    toggleFavorite,
    recordView,
    isWatching,
    watchSeats,
    unwatchSeats,
    isWatchingSeat,
    watchSeat,
    unwatchSeat,
  } = useAccount();

  // "Notify me when a seat opens"
  const [watchBusy, setWatchBusy] = useState(false);
  const [watchProblem, setWatchProblem] = useState<
    "" | "denied" | "simulator" | "not-configured" | "error"
  >("");

  // Count a view once per visit (same daily stats as the website)
  useEffect(() => {
    if (slug) {
      bumpPlaceStat(slug, "views");
    }
  }, [slug]);

  // Load restaurant + live tables + live markers
  useEffect(() => {
    // No slug is shown as "not found" during render, so there's nothing to load
    if (!slug) {
      return;
    }

    let unsubscribeTables: (() => void) | undefined;
    let unsubscribeMarkers: (() => void) | undefined;
    let cancelled = false;

    async function loadBusiness() {
      try {
        setLoading(true);
        setError("");
        setNotFound(false);

        const businessSnapshot = await getDoc(
          doc(db, "publicBusinesses", slug),
        );

        if (cancelled) {
          return;
        }

        if (!businessSnapshot.exists()) {
          setNotFound(true);
          setLoading(false);
          return;
        }

        const data = businessSnapshot.data();

        const businessData: PublicBusiness = {
          businessId: String(data.businessId ?? ""),
          name: String(data.name ?? "SeatMate location"),
          address: String(data.address ?? ""),
          type: String(data.type ?? "Restaurant"),
          imageUrl: String(
            data.imageUrl || data.coverImageUrl || data.photoUrl || "",
          ),
        };

        if (!businessData.businessId) {
          setError("This location is missing its business ID.");
          setLoading(false);
          return;
        }

        setBusiness(businessData);

        // LIVE TABLES

        unsubscribeTables = onSnapshot(
          collection(db, "businesses", businessData.businessId, "tables"),

          (snapshot) => {
            const tableData: Table[] = snapshot.docs.map((tableDoc, index) => {
              const table = tableDoc.data();

              const rawSeats = Array.isArray(table.seats) ? table.seats : [];

              const seats: Seat[] = rawSeats.map(
                (
                  seat: { id?: string | number; status?: string },
                  seatIndex: number,
                ) => ({
                  id: seat?.id ?? seatIndex + 1,
                  status:
                    seat?.status === "occupied" ? "occupied" : "available",
                }),
              );

              const rawTimestamp = table.occupancyUpdatedAt;

              const occupancyUpdatedAt: TimestampLike | null =
                rawTimestamp && typeof rawTimestamp.toMillis === "function"
                  ? rawTimestamp
                  : null;

              return {
                id: tableDoc.id,
                name: String(table.name ?? `Table ${index + 1}`),
                seats,
                xPct:
                  typeof table.xPct === "number"
                    ? clamp(table.xPct, 0, 100)
                    : 15 + (index % 3) * 30,
                yPct:
                  typeof table.yPct === "number"
                    ? clamp(table.yPct, 0, 100)
                    : 15 + Math.floor(index / 3) * 30,
                shape: table.shape === "round" ? "round" : "rectangle",
                scale:
                  typeof table.scale === "number"
                    ? clamp(table.scale, 0.65, 1.8)
                    : 1,
                occupancyUpdatedAt,
              };
            });

            setTables(tableData);
            setLoading(false);
          },

          (firebaseError) => {
            console.error("Table listener error:", firebaseError);
            setError("Could not load live seating.");
            setLoading(false);
          },
        );

        // LIVE FLOOR MARKERS

        unsubscribeMarkers = onSnapshot(
          collection(db, "businesses", businessData.businessId, "floorMarkers"),

          (snapshot) => {
            const markerData: FloorMarker[] = snapshot.docs.map(
              (markerDoc, index) => {
                const marker = markerDoc.data();

                const rawType = String(marker.type ?? "");

                const type: MarkerType =
                  rawType in MARKERS ? (rawType as MarkerType) : "outlet";

                return {
                  id: markerDoc.id,
                  type,
                  label:
                    typeof marker.label === "string"
                      ? marker.label
                      : MARKERS[type].label,
                  xPct:
                    typeof marker.xPct === "number"
                      ? clamp(marker.xPct, 0, 100)
                      : 15 + (index % 4) * 20,
                  yPct:
                    typeof marker.yPct === "number"
                      ? clamp(marker.yPct, 0, 100)
                      : 82,
                  scale:
                    typeof marker.scale === "number"
                      ? clamp(marker.scale, 0.5, 2.5)
                      : 1,
                  rotation:
                    typeof marker.rotation === "number" ? marker.rotation : 0,
                };
              },
            );

            setMarkers(markerData);
          },

          (firebaseError) => {
            console.error("Marker listener error:", firebaseError);
          },
        );
      } catch (loadError) {
        console.error("Place load error:", loadError);

        if (cancelled) {
          return;
        }

        setError("Could not load this SeatMate location.");
        setLoading(false);
      }
    }

    loadBusiness();

    return () => {
      cancelled = true;
      unsubscribeTables?.();
      unsubscribeMarkers?.();
    };
  }, [slug]);

  // -------------------------
  // SEAT COUNTS
  // -------------------------

  const totalSeats = tables.reduce(
    (total, table) => total + table.seats.length,
    0,
  );

  const availableSeats = tables.reduce(
    (total, table) =>
      total + table.seats.filter((seat) => seat.status === "available").length,
    0,
  );

  const occupiedSeats = totalSeats - availableSeats;

  const availability = getAvailability(availableSeats, totalSeats);

  const percentFree =
    totalSeats === 0 ? 0 : (availableSeats / totalSeats) * 100;

  // -------------------------
  // FRESHNESS
  // -------------------------

  const latestUpdateMs = tables.reduce<number | null>((latest, table) => {
    if (!table.occupancyUpdatedAt) {
      return latest;
    }

    const ms = table.occupancyUpdatedAt.toMillis();

    return latest === null || ms > latest ? ms : latest;
  }, null);

  const ageMinutes =
    latestUpdateMs === null
      ? null
      : Math.max(0, Math.floor((now - latestUpdateMs) / 60000));

  let freshnessLabel = "No updates yet";

  if (ageMinutes !== null) {
    if (ageMinutes < 1) {
      freshnessLabel = "Updated just now";
    } else if (ageMinutes < 60) {
      freshnessLabel = `Updated ${ageMinutes} min ago`;
    } else {
      const hours = Math.floor(ageMinutes / 60);
      freshnessLabel = `Updated ${hours} hr ago`;
    }
  }

  const isStale = ageMinutes !== null && ageMinutes >= STALE_MINUTES;

  // -------------------------
  // LAYOUT + FLOOR SIZING
  // -------------------------

  const contentWidth = Math.min(screenWidth, MAX_CONTENT_WIDTH);

  // Page padding (both sides) + floor border (both sides)
  const floorBoxWidth = contentWidth - PAGE_PADDING * 2 - 2;

  const hasFloorPlan = tables.length > 0 || markers.length > 0;

  const bounds = getFloorBounds(tables, markers);

  const selectedTable =
    tables.find((table) => table.id === selectedTableId) ?? null;

  // Zoom that fits the WHOLE layout inside the window (width and height)
  const fitZoom = Math.min(
    floorBoxWidth / bounds.width,
    MAX_FLOOR_BOX_HEIGHT / bounds.height,
    1.4,
  );

  // The window size is fixed. It never changes when zooming.
  const floorBoxHeight = clamp(
    bounds.height * fitZoom,
    MIN_FLOOR_BOX_HEIGHT,
    MAX_FLOOR_BOX_HEIGHT,
  );

  const zoom = fitZoom * ZOOM_LEVELS[zoomIndex];

  const floorContentWidth = bounds.width * zoom;
  const floorContentHeight = bounds.height * zoom;

  // When the layout is smaller than the window, center it
  const offsetX = Math.max(0, (floorBoxWidth - floorContentWidth) / 2);
  const offsetY = Math.max(0, (floorBoxHeight - floorContentHeight) / 2);

  const drawBounds: Bounds = {
    ...bounds,
    minX: bounds.minX - offsetX / zoom,
    minY: bounds.minY - offsetY / zoom,
  };

  const canvasWidth = Math.max(floorContentWidth, floorBoxWidth);
  const canvasHeight = Math.max(floorContentHeight, floorBoxHeight);

  const isZoomed = zoomIndex > 0;

  function changeZoom(nextIndex: number) {
    const next = clamp(nextIndex, 0, ZOOM_LEVELS.length - 1);

    if (next === zoomIndex) {
      return;
    }

    // Remember which spot to keep in view: the selected table,
    // or else whatever is in the middle of the window right now
    if (selectedTable) {
      zoomFocus.current = {
        x: (selectedTable.xPct / 100) * FLOOR_WIDTH,
        y: (selectedTable.yPct / 100) * FLOOR_HEIGHT,
      };
    } else {
      zoomFocus.current = {
        x:
          (scrollOffset.current.x + floorBoxWidth / 2) / zoom + drawBounds.minX,
        y:
          (scrollOffset.current.y + floorBoxHeight / 2) / zoom +
          drawBounds.minY,
      };
    }

    setZoomIndex(next);
  }

  // After zooming, scroll so the remembered spot is in the middle of the window
  useEffect(() => {
    const focus = zoomFocus.current;

    if (!focus) {
      return;
    }

    zoomFocus.current = null;

    const x = clamp(
      (focus.x - drawBounds.minX) * zoom - floorBoxWidth / 2,
      0,
      Math.max(0, canvasWidth - floorBoxWidth),
    );

    const y = clamp(
      (focus.y - drawBounds.minY) * zoom - floorBoxHeight / 2,
      0,
      Math.max(0, canvasHeight - floorBoxHeight),
    );

    scrollOffset.current = { x, y };

    requestAnimationFrame(() => {
      horizontalScrollRef.current?.scrollTo({ x, animated: false });
      verticalScrollRef.current?.scrollTo({ y, animated: false });
    });
  });

  function toggleTable(tableId: string) {
    setSelectedTableId((current) => (current === tableId ? null : tableId));
  }

  // Tables with the most free seats first
  const tableSummaries = tables
    .map((table) => ({
      id: table.id,
      name: table.name,
      free: table.seats.filter((seat) => seat.status === "available").length,
      total: table.seats.length,
    }))
    .sort((a, b) => b.free - a.free || a.name.localeCompare(b.name));

  // Tables with enough free seats for the whole group
  const openTables = tableSummaries.filter((summary) => summary.free >= party);

  const fullCount = tableSummaries.length - openTables.length;

  // -------------------------
  // SAVE + RECENTLY VIEWED
  // -------------------------

  // Add this place to "Recently viewed" on the account page
  useEffect(() => {
    if (!business || !profileReady) {
      return;
    }

    recordView({
      slug,
      name: business.name,
      address: business.address,
      type: business.type,
      imageUrl: business.imageUrl,
    });
  }, [business, profileReady, slug, recordView]);

  const saved = isFavorite(slug);

  async function toggleSave() {
    if (!business) {
      return;
    }

    // Saving needs an account; send signed-out people to sign in first
    if (!user) {
      router.push("/login");
      return;
    }

    await toggleFavorite({
      slug,
      name: business.name,
      address: business.address,
      type: business.type,
      imageUrl: business.imageUrl,
    });
  }

  // -------------------------
  // NOTIFY ME WHEN A SEAT OPENS
  // -------------------------

  const watching = isWatching(slug);

  // Full, or no single table has room for the whole group
  const noRoom = totalSeats > 0 && openTables.length === 0;

  async function toggleWatch() {
    if (!business) {
      return;
    }

    if (!user) {
      router.push("/login");
      return;
    }

    setWatchProblem("");
    setWatchBusy(true);

    try {
      if (watching) {
        await unwatchSeats(slug, business.businessId);
      } else {
        const result = await watchSeats(
          { slug, businessId: business.businessId, placeName: business.name },
          party,
        );

        if (result === "signin") {
          router.push("/login");
        } else if (result !== "ok") {
          setWatchProblem(result);
        }
      }
    } catch (watchError) {
      console.error("Seat alert error:", watchError);
      setWatchProblem("error");
    } finally {
      setWatchBusy(false);
    }
  }

  // "Notify me when this seat opens" (one specific seat)
  const [busySeatKey, setBusySeatKey] = useState("");

  async function toggleSeatWatch(table: Table, seat: Seat) {
    if (!business) {
      return;
    }

    if (!user) {
      router.push("/login");
      return;
    }

    const key = `${table.id}|${seat.id}`;

    setWatchProblem("");
    setBusySeatKey(key);

    try {
      if (isWatchingSeat(slug, table.id, seat.id)) {
        await unwatchSeat(slug, business.businessId, table.id, seat.id);
      } else {
        const result = await watchSeat(
          { slug, businessId: business.businessId, placeName: business.name },
          { id: table.id, name: table.name },
          seat.id,
        );

        if (result === "signin") {
          router.push("/login");
        } else if (result !== "ok") {
          setWatchProblem(result);
        }
      }
    } catch (seatError) {
      console.error("Seat alert error:", seatError);
      setWatchProblem("error");
    } finally {
      setBusySeatKey("");
    }
  }

  // -------------------------
  // DIRECTIONS
  // -------------------------

  async function openDirections() {
    if (!business || business.address === "") {
      return;
    }

    const destination = encodeURIComponent(business.address);

    const url =
      Platform.OS === "ios"
        ? `http://maps.apple.com/?daddr=${destination}`
        : `https://www.google.com/maps/dir/?api=1&destination=${destination}`;

    try {
      await Linking.openURL(url);
    } catch (linkError) {
      console.error("Directions error:", linkError);
    }
  }

  // -------------------------
  // LOADING
  // -------------------------

  if (loading && slug) {
    return (
      <SafeAreaView style={styles.centerPage}>
        <View style={styles.logoBox}>
          <Image
            source={splashIcon}
            alt=""
            style={{ width: 40, height: 40, tintColor: "#FFFFFF" }}
            resizeMode="contain"
          />
        </View>

        <ActivityIndicator
          size="small"
          color={C.textSoft}
          style={{ marginTop: 22 }}
        />

        <Text style={styles.loadingText}>Finding open seats…</Text>
      </SafeAreaView>
    );
  }

  // -------------------------
  // NOT FOUND / FAILED
  // -------------------------

  if (notFound || !business) {
    return (
      <SafeAreaView style={styles.centerPage}>
        <Ionicons name="storefront-outline" size={40} color={C.textMuted} />

        <Text style={styles.notFoundTitle}>
          {error !== "" ? "Something went wrong" : "Location not found"}
        </Text>

        <Text style={styles.notFoundText}>
          {error !== "" ? error : "This SeatMate location doesn't exist."}
        </Text>

        <PressableScale
          style={styles.primaryButton}
          onPress={() => router.back()}
        >
          <Text style={styles.primaryButtonText}>Go back</Text>
        </PressableScale>
      </SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        showsVerticalScrollIndicator={false}
        contentContainerStyle={styles.scrollContent}
      >
        <View style={[styles.page, { width: contentWidth }]}>
          {/* TOP BAR */}

          <View style={styles.topBar}>
            <PressableScale
              style={styles.backButton}
              onPress={() => router.back()}
              hitSlop={10}
            >
              <Ionicons name="chevron-back" size={20} color={C.text} />
            </PressableScale>

            {/* SAVE (heart) */}

            <PressableScale
              style={[styles.saveButton, saved ? styles.saveButtonActive : null]}
              onPress={toggleSave}
              hitSlop={10}
            >
              <Ionicons
                name={saved ? "heart" : "heart-outline"}
                size={18}
                color={saved ? C.taken : C.text}
              />

              <Text
                style={[styles.saveText, saved ? { color: C.takenText } : null]}
              >
                {saved ? "Saved" : "Save"}
              </Text>
            </PressableScale>
          </View>

          {/* SUMMARY */}

          <View style={styles.card}>
            <View style={styles.metaRow}>
              <View style={styles.liveDot} />
              <Text style={styles.metaLive}>Live</Text>
              <Text style={styles.metaDot}>·</Text>
              <Text style={styles.metaType}>{business.type}</Text>
            </View>

            <Text style={styles.businessName} numberOfLines={2}>
              {business.name}
            </Text>

            {business.address !== "" && (
              <View style={styles.addressRow}>
                <Ionicons
                  name="location-outline"
                  size={14}
                  color={C.textMuted}
                />
                <Text style={styles.addressText} numberOfLines={2}>
                  {business.address}
                </Text>
              </View>
            )}

            <View style={styles.divider} />

            <View style={styles.countRow}>
              <Text style={styles.countBig}>{availableSeats}</Text>
              <Text style={styles.countOf}>of {totalSeats} seats free</Text>

              <View style={{ flex: 1 }} />

              <View
                style={[
                  styles.statusPill,
                  { backgroundColor: availability.soft },
                ]}
              >
                <Text
                  style={[styles.statusPillText, { color: availability.ink }]}
                >
                  {availability.label}
                </Text>
              </View>
            </View>

            <View style={styles.progressTrack}>
              <View
                style={[
                  styles.progressFill,
                  {
                    width: `${totalSeats > 0 ? Math.max(percentFree, 2) : 0}%`,
                    backgroundColor: availability.color,
                  },
                ]}
              />
            </View>

            <View style={styles.footerRow}>
              <Ionicons
                name={isStale ? "alert-circle-outline" : "time-outline"}
                size={14}
                color={isStale ? C.someText : C.textMuted}
              />

              <Text
                style={[
                  styles.footerText,
                  isStale ? { color: C.someText } : null,
                ]}
                numberOfLines={1}
              >
                {freshnessLabel}
                {isStale ? " · may have changed" : ""}
                {!isStale && totalSeats > 0 ? ` · ${occupiedSeats} taken` : ""}
              </Text>

              {business.address !== "" && (
                <PressableScale
                  style={styles.directionsButton}
                  onPress={openDirections}
                >
                  <Ionicons name="navigate-outline" size={14} color={C.text} />
                  <Text style={styles.directionsText}>Directions</Text>
                </PressableScale>
              )}
            </View>
          </View>

          {/* NOTIFY ME WHEN A SEAT OPENS */}

          {SEAT_ALERTS_ENABLED && (noRoom || watching) && (
            <View style={styles.watchCard}>
              <View style={styles.watchHeader}>
                <View
                  style={[
                    styles.watchIcon,
                    watching ? { backgroundColor: C.freeSoft } : null,
                  ]}
                >
                  <Ionicons
                    name={watching ? "notifications" : "notifications-outline"}
                    size={18}
                    color={watching ? C.freeText : C.text}
                  />
                </View>

                <View style={{ flex: 1, marginLeft: 12 }}>
                  <Text style={styles.watchTitle}>
                    {watching
                      ? "We'll let you know"
                      : party > 1
                        ? `No table for ${partyLabel} right now`
                        : "Full right now"}
                  </Text>

                  <Text style={styles.watchText}>
                    {watching
                      ? `You'll get a notification when ${
                          party > 1 ? `a table for ${partyLabel}` : "a seat"
                        } opens here. Alerts last 12 hours.`
                      : "Get a notification the moment a seat opens up."}
                  </Text>
                </View>
              </View>

              <PressableScale
                style={[
                  styles.watchButton,
                  watching ? styles.watchButtonOff : null,
                  watchBusy ? { opacity: 0.6 } : null,
                ]}
                onPress={toggleWatch}
                disabled={watchBusy}
              >
                {watchBusy ? (
                  <ActivityIndicator color={watching ? C.text : "#FFFFFF"} />
                ) : (
                  <Text
                    style={[
                      styles.watchButtonText,
                      watching ? { color: C.text } : null,
                    ]}
                  >
                    {watching
                      ? "Turn off alert"
                      : party > 1
                        ? `Notify me when a table for ${partyLabel} opens`
                        : "Notify me when a seat opens"}
                  </Text>
                )}
              </PressableScale>

              {watchProblem !== "" && (
                <View style={styles.watchProblem}>
                  <Text style={styles.watchProblemText}>
                    {watchProblem === "denied"
                      ? "Notifications are turned off for SeatMate."
                      : watchProblem === "simulator"
                        ? "Notifications only work on a real phone."
                        : watchProblem === "not-configured"
                          ? "Notifications aren't set up in this build yet."
                          : "We couldn't turn on the alert. Please try again."}
                  </Text>

                  {watchProblem === "denied" && (
                    <PressableScale onPress={() => Linking.openSettings()}>
                      <Text style={styles.watchSettingsLink}>Open Settings</Text>
                    </PressableScale>
                  )}
                </View>
              )}
            </View>
          )}

          {error !== "" && (
            <View style={styles.errorBox}>
              <Ionicons
                name="alert-circle-outline"
                size={16}
                color={C.takenText}
              />
              <Text style={styles.errorText}>{error}</Text>
            </View>
          )}

          {/* FLOOR HEADER */}

          <View style={styles.sectionHeader}>
            <View style={{ flex: 1 }}>
              <Text style={styles.sectionTitle}>Floor plan</Text>

              <View style={styles.legendRow}>
                <View style={[styles.legendDot, { backgroundColor: C.free }]} />
                <Text style={styles.legendText}>Free</Text>

                <View
                  style={[
                    styles.legendDot,
                    { backgroundColor: C.taken, marginLeft: 12 },
                  ]}
                />
                <Text style={styles.legendText}>Taken</Text>
              </View>
            </View>

            {hasFloorPlan && (
              <View style={styles.zoomGroup}>
                <PressableScale
                  style={styles.zoomButton}
                  onPress={() => changeZoom(zoomIndex - 1)}
                  disabled={zoomIndex === 0}
                >
                  <Ionicons
                    name="remove"
                    size={18}
                    color={zoomIndex === 0 ? C.border : C.text}
                  />
                </PressableScale>

                <View style={styles.zoomDivider} />

                <PressableScale
                  style={styles.zoomButton}
                  onPress={() => changeZoom(zoomIndex + 1)}
                  disabled={zoomIndex === ZOOM_LEVELS.length - 1}
                >
                  <Ionicons
                    name="add"
                    size={18}
                    color={
                      zoomIndex === ZOOM_LEVELS.length - 1 ? C.border : C.text
                    }
                  />
                </PressableScale>
              </View>
            )}
          </View>

          {/* FLOOR */}

          <View style={styles.floorBox}>
            {!hasFloorPlan ? (
              <View style={styles.emptyFloor}>
                <Ionicons name="grid-outline" size={26} color={C.textMuted} />
                <Text style={styles.emptyFloorTitle}>No floor plan yet</Text>
                <Text style={styles.emptyFloorText}>
                  {"This place hasn't published its layout."}
                </Text>
              </View>
            ) : (
              <ScrollView
                ref={horizontalScrollRef}
                horizontal
                scrollEnabled={isZoomed}
                bounces={false}
                showsHorizontalScrollIndicator={false}
                scrollEventThrottle={16}
                onScroll={(event) => {
                  scrollOffset.current.x = event.nativeEvent.contentOffset.x;
                }}
                style={{ width: floorBoxWidth, height: floorBoxHeight }}
              >
                <ScrollView
                  ref={verticalScrollRef}
                  nestedScrollEnabled
                  scrollEnabled={isZoomed}
                  bounces={false}
                  showsVerticalScrollIndicator={false}
                  scrollEventThrottle={16}
                  onScroll={(event) => {
                    scrollOffset.current.y = event.nativeEvent.contentOffset.y;
                  }}
                  style={{ width: canvasWidth, height: floorBoxHeight }}
                >
                  <View style={{ width: canvasWidth, height: canvasHeight }}>
                    {markers.map((marker) => (
                      <FloorMarkerView
                        key={marker.id}
                        marker={marker}
                        bounds={drawBounds}
                        zoom={zoom}
                      />
                    ))}

                    {tables.map((table) => (
                      <TableView
                        key={table.id}
                        table={table}
                        bounds={drawBounds}
                        zoom={zoom}
                        selected={table.id === selectedTableId}
                        dimmed={
                          selectedTableId !== null &&
                          table.id !== selectedTableId
                        }
                        onPress={() => toggleTable(table.id)}
                        isSeatWatched={(seat) =>
                          isWatchingSeat(slug, table.id, seat.id)
                        }
                      />
                    ))}
                  </View>
                </ScrollView>
              </ScrollView>
            )}
          </View>

          {/* SELECTED TABLE / HINT */}

          {selectedTable ? (
            <SelectedTableCard
              table={selectedTable}
              onClose={() => toggleTable(selectedTable.id)}
              isSeatWatched={(seat) =>
                isWatchingSeat(slug, selectedTable.id, seat.id)
              }
              busySeatKey={busySeatKey}
              onSeatPress={(seat) => toggleSeatWatch(selectedTable, seat)}
              problem={watchProblem}
            />
          ) : (
            tables.length > 0 && (
              <Text style={styles.hint}>
                {isZoomed
                  ? "Tap a table for details · drag to move around"
                  : "Tap a table for details"}
              </Text>
            )
          )}

          {/* OPEN TABLES (one calm row you can swipe) */}

          {tableSummaries.length > 0 && (
            <View style={styles.quickSection}>
              <Text style={styles.quickTitle}>
                {party === 1
                  ? openTables.length > 0
                    ? `Open tables · ${openTables.length}`
                    : "No open tables right now"
                  : openTables.length > 0
                    ? `Tables for ${partyLabel} · ${openTables.length}`
                    : `No table for ${partyLabel} right now`}
              </Text>

              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.quickRow}
                style={styles.quickScroll}
              >
                {openTables.map((summary) => {
                  const isSelected = summary.id === selectedTableId;

                  return (
                    <PressableScale
                      key={summary.id}
                      onPress={() => toggleTable(summary.id)}
                      style={[
                        styles.quickPill,
                        isSelected ? styles.quickPillSelected : null,
                      ]}
                    >
                      <Text
                        style={[
                          styles.quickName,
                          isSelected ? { color: "#FFFFFF" } : null,
                        ]}
                        numberOfLines={1}
                      >
                        {summary.name}
                      </Text>

                      <Text
                        style={[
                          styles.quickCount,
                          isSelected
                            ? { color: "rgba(255,255,255,0.75)" }
                            : null,
                        ]}
                      >
                        {summary.free} free
                      </Text>
                    </PressableScale>
                  );
                })}

                {fullCount > 0 && (
                  <View style={styles.quickPillMuted}>
                    <Text style={styles.quickMutedText}>
                      {party === 1
                        ? `${fullCount} full`
                        : `${fullCount} too small or full`}
                    </Text>
                  </View>
                )}
              </ScrollView>
            </View>
          )}

          <Text style={styles.pageFooter}>
            Seats update live as staff make changes.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

// -------------------------
// PRESSABLE WITH A SOFT PRESS EFFECT
// -------------------------

function PressableScale({
  children,
  style,
  onPress,
  disabled,
  hitSlop,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
  onPress?: () => void;
  disabled?: boolean;
  hitSlop?: number;
}) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={hitSlop}
      style={({ pressed }) => [
        style,
        pressed && !disabled
          ? { opacity: 0.7, transform: [{ scale: 0.97 }] }
          : null,
      ]}
    >
      {children}
    </Pressable>
  );
}

// -------------------------
// SEAT POSITION
// -------------------------

// Seats go clockwise from the top (same order as the business website),
// placed just outside the table edge so they never overlap the table.
function getSeatPosition(
  index: number,
  count: number,
  isRound: boolean,
  tableWidth: number,
  tableHeight: number,
  seatSize: number,
  zoom: number,
) {
  const angle = -Math.PI / 2 + (index / Math.max(count, 1)) * Math.PI * 2;

  const dx = Math.cos(angle);
  const dy = Math.sin(angle);

  const gap = clamp(5 * zoom, 2, 6);
  const push = gap + seatSize / 2;

  if (isRound) {
    const radius = tableWidth / 2 + push;
    return { x: dx * radius, y: dy * radius };
  }

  const halfW = tableWidth / 2;
  const halfH = tableHeight / 2;

  // Where a line from the center at this angle meets the table edge
  const toSide = Math.abs(dx) > 0.0001 ? halfW / Math.abs(dx) : Infinity;
  const toTopBottom = Math.abs(dy) > 0.0001 ? halfH / Math.abs(dy) : Infinity;

  if (toSide <= toTopBottom) {
    // Left or right side
    return {
      x: Math.sign(dx) * (halfW + push),
      y: clamp(dy * toSide, -halfH, halfH),
    };
  }

  // Top or bottom side
  return {
    x: clamp(dx * toTopBottom, -halfW, halfW),
    y: Math.sign(dy) * (halfH + push),
  };
}

// -------------------------
// TABLE
// -------------------------

function TableView({
  table,
  bounds,
  zoom,
  selected,
  dimmed,
  onPress,
  isSeatWatched,
}: {
  table: Table;
  bounds: Bounds;
  zoom: number;
  selected: boolean;
  dimmed: boolean;
  onPress: () => void;
  isSeatWatched: (seat: Seat) => boolean;
}) {
  const isRound = table.shape === "round";

  const box = getTableBox(table);

  const containerWidth = box.width * zoom;
  const containerHeight = box.height * zoom;

  const tableWidth = (isRound ? 88 : 125) * table.scale * zoom;
  const tableHeight = (isRound ? 88 : 76) * table.scale * zoom;

  const centerX = ((table.xPct / 100) * FLOOR_WIDTH - bounds.minX) * zoom;
  const centerY = ((table.yPct / 100) * FLOOR_HEIGHT - bounds.minY) * zoom;

  // Everything scales with the layout so nothing overlaps
  const seatSize = clamp(24 * table.scale * zoom, 8, 30);
  const nameFont = clamp(13 * table.scale * zoom, 9, 14);
  const showName = tableWidth >= 46 && tableHeight >= 20;
  const showSeatNumbers = seatSize >= 22;

  return (
    <Pressable
      onPress={onPress}
      hitSlop={4}
      style={({ pressed }) => [
        styles.tableContainer,
        {
          left: centerX - containerWidth / 2,
          top: centerY - containerHeight / 2,
          width: containerWidth,
          height: containerHeight,
          opacity: dimmed ? 0.45 : pressed ? 0.75 : 1,
        },
      ]}
    >
      <View
        style={[
          styles.tableSurface,
          selected ? styles.tableSurfaceSelected : null,
          {
            width: tableWidth,
            height: tableHeight,
            left: containerWidth / 2 - tableWidth / 2,
            top: containerHeight / 2 - tableHeight / 2,
            borderRadius: isRound ? tableWidth / 2 : clamp(10 * zoom, 4, 12),
          },
        ]}
      >
        {showName && (
          <Text
            style={[
              styles.tableName,
              { fontSize: nameFont },
              selected ? { color: "#FFFFFF" } : null,
            ]}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.8}
          >
            {table.name}
          </Text>
        )}
      </View>

      {table.seats.map((seat, index) => {
        const { x, y } = getSeatPosition(
          index,
          table.seats.length,
          isRound,
          tableWidth,
          tableHeight,
          seatSize,
          zoom,
        );

        const left = containerWidth / 2 + x;
        const top = containerHeight / 2 + y;

        const isFree = seat.status === "available";

        return (
          <View
            key={`${table.id}-${seat.id}-${index}`}
            style={[
              styles.seat,
              {
                left: left - seatSize / 2,
                top: top - seatSize / 2,
                width: seatSize,
                height: seatSize,
                borderRadius: seatSize / 2,
                borderWidth: seatSize >= 14 ? 2 : 1,
                backgroundColor: isFree ? C.free : C.taken,
              },
              // Seat you asked to be notified about
              isSeatWatched(seat)
                ? { borderColor: C.dark, borderWidth: seatSize >= 14 ? 3 : 2 }
                : null,
            ]}
          >
            {showSeatNumbers && (
              <Text
                style={[
                  styles.seatText,
                  { fontSize: clamp(seatSize * 0.4, 9, 12) },
                ]}
              >
                {seat.id}
              </Text>
            )}
          </View>
        );
      })}
    </Pressable>
  );
}

// -------------------------
// SELECTED TABLE CARD
// -------------------------

function SelectedTableCard({
  table,
  onClose,
  isSeatWatched,
  busySeatKey,
  onSeatPress,
  problem,
}: {
  table: Table;
  onClose: () => void;
  isSeatWatched: (seat: Seat) => boolean;
  busySeatKey: string;
  onSeatPress: (seat: Seat) => void;
  problem: string;
}) {
  const free = table.seats.filter((seat) => seat.status === "available").length;
  const hasTakenSeats = free < table.seats.length;
  const watchingAny = table.seats.some((seat) => isSeatWatched(seat));

  return (
    <View style={[styles.card, styles.selectedCard]}>
      <View style={styles.selectedHeader}>
        <View style={{ flex: 1 }}>
          <Text style={styles.selectedName}>{table.name}</Text>

          <Text
            style={[
              styles.selectedCount,
              { color: free > 0 ? C.freeText : C.takenText },
            ]}
          >
            {free > 0
              ? `${free} of ${table.seats.length} seats free`
              : "All seats taken"}
          </Text>
        </View>

        <PressableScale
          style={styles.closeButton}
          onPress={onClose}
          hitSlop={10}
        >
          <Ionicons name="close" size={16} color={C.textSoft} />
        </PressableScale>
      </View>

      <View style={styles.seatChips}>
        {table.seats.map((seat, index) => {
          const isFree = seat.status === "available";
          const watched = isSeatWatched(seat);
          const busy = busySeatKey === `${table.id}|${seat.id}`;

          // Free seats (and all seats while alerts are off): just a label
          if (isFree || !SEAT_ALERTS_ENABLED) {
            return (
              <View
                key={`${table.id}-chip-${seat.id}-${index}`}
                style={[
                  styles.seatChip,
                  { backgroundColor: isFree ? C.freeSoft : C.takenSoft },
                ]}
              >
                <View
                  style={[
                    styles.seatChipDot,
                    { backgroundColor: isFree ? C.free : C.taken },
                  ]}
                />
                <Text
                  style={[
                    styles.seatChipText,
                    { color: isFree ? C.freeText : C.takenText },
                  ]}
                >
                  Seat {seat.id}
                </Text>
              </View>
            );
          }

          // Taken seats: tap to get notified when this one opens
          return (
            <PressableScale
              key={`${table.id}-chip-${seat.id}-${index}`}
              onPress={() => onSeatPress(seat)}
              disabled={busy}
              style={[
                styles.seatChip,
                { backgroundColor: C.takenSoft },
                watched ? styles.seatChipWatched : null,
              ]}
            >
              {busy ? (
                <ActivityIndicator
                  size="small"
                  color={watched ? "#FFFFFF" : C.takenText}
                  style={{ marginRight: 6, transform: [{ scale: 0.7 }] }}
                />
              ) : (
                <Ionicons
                  name={watched ? "notifications" : "notifications-outline"}
                  size={13}
                  color={watched ? "#FFFFFF" : C.takenText}
                  style={{ marginRight: 5 }}
                />
              )}

              <Text
                style={[
                  styles.seatChipText,
                  { color: watched ? "#FFFFFF" : C.takenText },
                ]}
              >
                Seat {seat.id}
              </Text>
            </PressableScale>
          );
        })}
      </View>

      {SEAT_ALERTS_ENABLED && hasTakenSeats && (
        <Text style={styles.seatHint}>
          {watchingAny
            ? "We'll notify you when your seat opens. Tap it again to turn off."
            : "Want a specific seat? Tap a taken seat to get notified when it opens."}
        </Text>
      )}

      {problem !== "" && (
        <View style={styles.watchProblem}>
          <Text style={styles.watchProblemText}>
            {problem === "denied"
              ? "Notifications are turned off for SeatMate."
              : problem === "simulator"
                ? "Notifications only work on a real phone."
                : problem === "not-configured"
                  ? "Notifications aren't set up in this build yet."
                  : "We couldn't turn on the alert. Please try again."}
          </Text>

          {problem === "denied" && (
            <PressableScale onPress={() => Linking.openSettings()}>
              <Text style={styles.watchSettingsLink}>Open Settings</Text>
            </PressableScale>
          )}
        </View>
      )}
    </View>
  );
}

// -------------------------
// FLOOR MARKER
// -------------------------

function FloorMarkerView({
  marker,
  bounds,
  zoom,
}: {
  marker: FloorMarker;
  bounds: Bounds;
  zoom: number;
}) {
  const info = MARKERS[marker.type];
  const look = MARKER_LOOK[marker.type];

  const width = info.width * marker.scale * zoom;
  const height = info.height * marker.scale * zoom;

  const centerX = ((marker.xPct / 100) * FLOOR_WIDTH - bounds.minX) * zoom;
  const centerY = ((marker.yPct / 100) * FLOOR_HEIGHT - bounds.minY) * zoom;

  const isWall = marker.type === "wall";

  const iconFont = clamp(Math.min(width, height) * 0.42, 8, 15);
  const labelFont = clamp(height * 0.22, 8, 10);

  const showIcon = !isWall && info.icon !== "" && Math.min(width, height) >= 14;
  const showLabel = !isWall && height >= 34 && width >= 60;

  return (
    <View
      pointerEvents="none"
      style={[
        styles.marker,
        {
          left: centerX - width / 2,
          top: centerY - height / 2,
          width,
          height,
          backgroundColor: look.bg,
          borderColor: look.border,
          borderRadius: isWall ? 2 : clamp(8 * zoom, 3, 8),
          transform: [{ rotate: `${marker.rotation}deg` }],
        },
      ]}
    >
      {showIcon && (
        <Text
          style={[styles.markerIcon, { color: look.ink, fontSize: iconFont }]}
        >
          {info.icon}
        </Text>
      )}

      {showLabel && (
        <Text
          numberOfLines={1}
          style={[styles.markerLabel, { color: look.ink, fontSize: labelFont }]}
        >
          {marker.label}
        </Text>
      )}
    </View>
  );
}

// -------------------------
// STYLES
// -------------------------

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: C.page },

  scrollContent: { alignItems: "center", paddingBottom: 40 },

  page: { paddingHorizontal: PAGE_PADDING },

  centerPage: {
    flex: 1,
    backgroundColor: C.page,
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
  },

  logoBox: {
    width: 64,
    height: 64,
    borderRadius: 20,
    backgroundColor: "#000000",
    alignItems: "center",
    justifyContent: "center",
  },

  loadingText: { marginTop: 10, color: C.textSoft, fontSize: 14 },

  notFoundTitle: {
    marginTop: 16,
    fontSize: 20,
    fontWeight: "800",
    color: C.text,
  },

  notFoundText: {
    marginTop: 6,
    color: C.textSoft,
    textAlign: "center",
    lineHeight: 20,
  },

  primaryButton: {
    marginTop: 22,
    backgroundColor: C.dark,
    borderRadius: 14,
    paddingHorizontal: 22,
    paddingVertical: 12,
  },

  primaryButtonText: { color: "#FFFFFF", fontWeight: "700", fontSize: 15 },

  // TOP BAR

  topBar: {
    height: 52,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },

  saveButton: {
    flexDirection: "row",
    alignItems: "center",
    height: 38,
    paddingHorizontal: 14,
    borderRadius: 19,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
  },

  saveButtonActive: { backgroundColor: C.takenSoft, borderColor: C.takenSoft },

  saveText: { marginLeft: 6, fontSize: 14, fontWeight: "700", color: C.text },

  backButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    alignItems: "center",
    justifyContent: "center",
  },

  // CARDS

  card: {
    backgroundColor: C.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    padding: 18,
  },

  metaRow: { flexDirection: "row", alignItems: "center" },

  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: C.free,
    marginRight: 6,
  },

  metaLive: { color: C.freeText, fontSize: 13, fontWeight: "700" },

  metaDot: { color: C.textMuted, marginHorizontal: 6 },

  metaType: { color: C.textSoft, fontSize: 13, fontWeight: "600" },

  businessName: {
    marginTop: 6,
    fontSize: 24,
    lineHeight: 29,
    fontWeight: "800",
    color: C.text,
    letterSpacing: -0.3,
  },

  addressRow: { flexDirection: "row", alignItems: "center", marginTop: 6 },

  addressText: {
    marginLeft: 4,
    color: C.textSoft,
    fontSize: 14,
    flexShrink: 1,
  },

  divider: { height: 1, backgroundColor: C.divider, marginVertical: 16 },

  countRow: { flexDirection: "row", alignItems: "flex-end" },

  countBig: {
    fontSize: 34,
    lineHeight: 36,
    fontWeight: "800",
    color: C.text,
    letterSpacing: -0.5,
  },

  countOf: { marginLeft: 6, marginBottom: 4, color: C.textSoft, fontSize: 14 },

  statusPill: {
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 5,
    marginBottom: 3,
  },

  statusPillText: { fontSize: 12, fontWeight: "700" },

  progressTrack: {
    height: 6,
    borderRadius: 3,
    backgroundColor: C.divider,
    marginTop: 12,
    overflow: "hidden",
  },

  progressFill: { height: 6, borderRadius: 3 },

  footerRow: { flexDirection: "row", alignItems: "center", marginTop: 14 },

  footerText: {
    flex: 1,
    marginLeft: 5,
    marginRight: 10,
    color: C.textSoft,
    fontSize: 13,
  },

  directionsButton: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.page,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 999,
    paddingHorizontal: 12,
    paddingVertical: 7,
  },

  directionsText: {
    marginLeft: 5,
    color: C.text,
    fontSize: 13,
    fontWeight: "700",
  },

  // NOTIFY ME

  watchCard: {
    marginTop: 12,
    backgroundColor: C.card,
    borderRadius: 20,
    borderWidth: 1,
    borderColor: C.border,
    padding: 16,
  },

  watchHeader: { flexDirection: "row", alignItems: "center" },

  watchIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: C.page,
    alignItems: "center",
    justifyContent: "center",
  },

  watchTitle: { fontSize: 16, fontWeight: "800", color: C.text },

  watchText: { marginTop: 2, fontSize: 13, lineHeight: 18, color: C.textSoft },

  watchButton: {
    marginTop: 14,
    height: 48,
    borderRadius: 14,
    backgroundColor: C.dark,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 16,
  },

  watchButtonOff: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
  },

  watchButtonText: { color: "#FFFFFF", fontSize: 15, fontWeight: "700" },

  watchProblem: {
    marginTop: 12,
    backgroundColor: C.someSoft,
    borderRadius: 12,
    padding: 12,
  },

  watchProblemText: { color: C.someText, fontSize: 13, lineHeight: 18 },

  watchSettingsLink: {
    marginTop: 6,
    color: C.text,
    fontSize: 13,
    fontWeight: "700",
    textDecorationLine: "underline",
  },

  errorBox: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.takenSoft,
    borderRadius: 14,
    padding: 12,
    marginTop: 12,
  },

  errorText: {
    marginLeft: 6,
    color: C.takenText,
    fontWeight: "600",
    fontSize: 13,
    flex: 1,
  },

  // FLOOR

  sectionHeader: {
    flexDirection: "row",
    alignItems: "flex-end",
    marginTop: 26,
  },

  sectionTitle: {
    color: C.text,
    fontSize: 18,
    fontWeight: "800",
    letterSpacing: -0.2,
  },

  legendRow: { flexDirection: "row", alignItems: "center", marginTop: 6 },

  legendDot: { width: 8, height: 8, borderRadius: 4, marginRight: 5 },

  legendText: { color: C.textSoft, fontSize: 13 },

  zoomGroup: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 12,
  },

  zoomButton: {
    width: 40,
    height: 34,
    alignItems: "center",
    justifyContent: "center",
  },

  zoomDivider: { width: 1, height: 18, backgroundColor: C.border },

  floorBox: {
    marginTop: 12,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 20,
    overflow: "hidden",
    backgroundColor: C.floor,
  },

  hint: {
    marginTop: 10,
    color: C.textMuted,
    fontSize: 13,
    textAlign: "center",
  },

  emptyFloor: {
    alignItems: "center",
    paddingVertical: 44,
    paddingHorizontal: 20,
  },

  emptyFloorTitle: {
    marginTop: 10,
    color: C.text,
    fontSize: 16,
    fontWeight: "700",
  },

  emptyFloorText: {
    color: C.textSoft,
    marginTop: 4,
    textAlign: "center",
    fontSize: 14,
  },

  tableContainer: { position: "absolute" },

  tableSurface: {
    position: "absolute",
    backgroundColor: C.table,
    borderWidth: 1,
    borderColor: C.tableBorder,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 3,
  },

  tableSurfaceSelected: { backgroundColor: C.dark, borderColor: C.dark },

  tableName: { color: C.tableText, fontWeight: "700", textAlign: "center" },

  seat: {
    position: "absolute",
    borderColor: C.floor,
    alignItems: "center",
    justifyContent: "center",
  },

  seatText: { color: "#FFFFFF", fontWeight: "700" },

  marker: {
    position: "absolute",
    borderWidth: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 2,
  },

  markerIcon: { fontWeight: "600" },

  markerLabel: { fontWeight: "600", textAlign: "center", marginTop: 1 },

  // SELECTED TABLE

  selectedCard: { marginTop: 12, padding: 16 },

  selectedHeader: { flexDirection: "row", alignItems: "center" },

  selectedName: { color: C.text, fontSize: 17, fontWeight: "800" },

  selectedCount: { marginTop: 2, fontSize: 14, fontWeight: "600" },

  closeButton: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: C.page,
    alignItems: "center",
    justifyContent: "center",
  },

  seatChips: { flexDirection: "row", flexWrap: "wrap", marginTop: 12 },

  seatChip: {
    flexDirection: "row",
    alignItems: "center",
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 6,
    marginBottom: 6,
  },

  seatChipDot: { width: 7, height: 7, borderRadius: 4, marginRight: 6 },

  seatChipText: { fontSize: 13, fontWeight: "600" },

  seatChipWatched: { backgroundColor: C.dark },

  seatHint: { marginTop: 4, fontSize: 13, lineHeight: 18, color: C.textMuted },

  // OPEN TABLES

  quickSection: { marginTop: 22 },

  quickTitle: { color: C.textSoft, fontSize: 14, fontWeight: "600" },

  quickScroll: { marginHorizontal: -PAGE_PADDING, marginTop: 10 },

  quickRow: { paddingHorizontal: PAGE_PADDING },

  quickPill: {
    backgroundColor: C.card,
    borderWidth: 1,
    borderColor: C.border,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 9,
    marginRight: 8,
    minWidth: 86,
  },

  quickPillSelected: { backgroundColor: C.dark, borderColor: C.dark },

  quickName: { color: C.text, fontSize: 14, fontWeight: "600", maxWidth: 140 },

  quickCount: {
    marginTop: 2,
    color: C.freeText,
    fontSize: 12,
    fontWeight: "600",
  },

  quickPillMuted: {
    justifyContent: "center",
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: "#EFEFEC",
  },

  quickMutedText: { color: C.textMuted, fontSize: 13, fontWeight: "600" },

  pageFooter: {
    marginTop: 20,
    color: C.textMuted,
    textAlign: "center",
    fontSize: 12,
  },
});
