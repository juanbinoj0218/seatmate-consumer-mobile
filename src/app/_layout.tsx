import { useEffect, useRef } from "react";
import { DefaultTheme, Stack, ThemeProvider, useRouter } from "expo-router";
import * as Notifications from "expo-notifications";
import * as SplashScreen from "expo-splash-screen";

import { AccountProvider } from "../lib/account";

SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const router = useRouter();

  useEffect(() => {
    SplashScreen.hideAsync();
  }, []);

  // Tapping a "seat just opened" notification opens that place.
  // Works whether the app was closed, in the background, or open.
  const lastResponse = Notifications.useLastNotificationResponse();
  const handledId = useRef<string | null>(null);

  useEffect(() => {
    if (!lastResponse) {
      return;
    }

    const id = lastResponse.notification.request.identifier;

    if (handledId.current === id) {
      return;
    }

    handledId.current = id;

    const data = lastResponse.notification.request.content.data ?? {};
    const slug = data.slug;
    const tableId = data.tableId;

    if (typeof slug === "string" && slug !== "") {
      router.push({
        pathname: "/place/[slug]",
        // Seat alerts also open the table with that seat
        params:
          typeof tableId === "string" && tableId !== ""
            ? { slug, table: tableId }
            : { slug },
      });
    }
  }, [lastResponse, router]);

  return (
    <ThemeProvider value={DefaultTheme}>
      {/* Makes the signed-in account available on every screen */}
      <AccountProvider>
        <Stack screenOptions={{ headerShown: false }}>
          {/* Sign in slides up from the bottom, like a sheet */}
          <Stack.Screen name="login" options={{ presentation: "modal" }} />
        </Stack>
      </AccountProvider>
    </ThemeProvider>
  );
}
