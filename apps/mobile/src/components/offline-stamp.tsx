import { useEffect, useSyncExternalStore } from "react";
import { AppState, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { formatTime } from "@/lib/format";
import { announceOnline, isOffline, oldestSavedCopy, subscribeSavedCopy } from "@/lib/offline-stamp";
import { serverAnswers } from "@/lib/server-reachable";

const PROBE_EVERY_MS = 10_000;
/** The tab bar's height plus a gap, in dp. */
const TAB_BAR_CLEARANCE = 76;

export function OfflineStampHost() {
  const at = useSyncExternalStore(subscribeSavedCopy, oldestSavedCopy);
  const insets = useSafeAreaInsets();
  const dates = useDates();
  const offline = useSyncExternalStore(subscribeSavedCopy, isOffline);

  /*
   * Nothing else tells the app the network is back, so while the stamp is up
   * it asks every 10 s and on each return to the foreground. Off the rest of
   * the time: no polling while online.
   */
  useEffect(() => {
    if (!offline) return;

    let busy = false;
    const probe = async () => {
      if (busy) return;
      busy = true;
      if (await serverAnswers()) announceOnline();
      busy = false;
    };
    const timer = setInterval(() => void probe(), PROBE_EVERY_MS);
    const resume = AppState.addEventListener("change", (state) => {
      if (state === "active") void probe();
    });

    return () => {
      clearInterval(timer);
      resume.remove();
    };
  }, [offline]);

  if (at === null) return null;

  const date = new Date(at);
  const today = dates.date(date) === dates.date(new Date());

  return (
    <View
      className="absolute inset-x-0 items-center"
      pointerEvents="none"
      // Above the tab bar, not over the header: at the top it sat on the logo
      // and on every centred screen title (owner's screenshot, 2026-11-16).
      style={{ bottom: insets.bottom + TAB_BAR_CLEARANCE }}
    >
      <View className="rounded-full bg-foreground px-3 py-1">
        <Text className="text-xs font-semibold text-background" variant={null}>
          Offline · {today ? formatTime(date) : dates.dateTime(date)}
        </Text>
      </View>
    </View>
  );
}
