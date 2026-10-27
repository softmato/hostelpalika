import { useSyncExternalStore } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { formatTime } from "@/lib/format";
import { oldestSavedCopy, subscribeSavedCopy } from "@/lib/offline-stamp";

/** "Offline · Updated 14:05" over the top of a screen showing saved answers. Never takes a tap. */
export function OfflineStampHost() {
  const at = useSyncExternalStore(subscribeSavedCopy, oldestSavedCopy);
  const insets = useSafeAreaInsets();
  const dates = useDates();

  if (at === null) return null;

  const date = new Date(at);
  const today = dates.date(date) === dates.date(new Date());

  return (
    <View
      className="absolute inset-x-0 items-center"
      pointerEvents="none"
      style={{ top: insets.top + 4 }}
    >
      <View className="rounded-full bg-foreground px-3 py-1">
        <Text className="text-xs font-semibold text-background" variant={null}>
          Offline · Updated {today ? formatTime(date) : dates.dateTime(date)}
        </Text>
      </View>
    </View>
  );
}
