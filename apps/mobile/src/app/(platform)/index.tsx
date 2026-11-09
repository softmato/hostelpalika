import { router } from "expo-router";
import { useMemo } from "react";
import { View } from "react-native";

import { NotificationBell } from "@/components/notification-bell";
import { SYSTEM_TILES } from "@/components/platform-system";
import { FLOAT_SHADOW } from "@/components/portal-shared";
import { ActionTiles, type ActionTile } from "@/components/ui/action-grid";
import { AppBar } from "@/components/ui/app-bar";
import { Screen } from "@/components/ui/screen";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { getActiveUsers } from "@/lib/platform-api";

/**
 * Platform Home — who is using the product today on the card pulled up onto
 * the header, with Active users and Analytics. The server's own health (logs,
 * process, cron, failing jobs) is the System tab.
 */

const STRADDLE = 34;

const HOME_TILES = SYSTEM_TILES.filter((tile) => ["Active users", "Analytics"].includes(tile.label));


function TodayCard() {
  const dates = useDates();
  const active = useResource(getActiveUsers, { cacheKey: "platform:active-users:today" });
  const data = active.data;

  return (
    <View className="flex-row gap-3 rounded-2xl border border-border bg-card p-4" style={FLOAT_SHADOW}>
      {[
        { label: data ? dates.dayMonth(data.day) : "Today", value: data?.dau },
        { label: "7 days", value: data?.wau },
        { label: "30 days", value: data?.mau },
      ].map((cell) => (
        <View className="flex-1 gap-1" key={cell.label}>
          {active.loading ? <Skeleton className="h-7 w-12" /> : <Text variant="title">{cell.value ?? "—"}</Text>}
          <Text className="text-xs" variant="muted">
            {cell.label}
          </Text>
        </View>
      ))}
    </View>
  );
}

export default function PlatformHomeScreen() {
  const account = useAppSelector((state) => state.auth.account);
  const tiles = useMemo<ActionTile[]>(
    () =>
      HOME_TILES.map((tile) => ({
        glyph: tile.glyph,
        icon: tile.icon,
        key: tile.href,
        label: tile.label,
        onPress: () => router.push(tile.href),
        tone: tile.tone,
      })),
    [],
  );

  const header = (
    <View className="bg-background">
      <AppBar accent actions={<NotificationBell tone="onAccent" />} large straddle={STRADDLE} subtitle={account?.name ?? undefined} title="Platform" />
      <View className="px-5" style={{ marginTop: -STRADDLE }}>
        <TodayCard />
      </View>
    </View>
  );

  return (
    <Screen header={header} insideTabs scroll>
      <View className="gap-5 pt-4">
        <ActionTiles tiles={tiles} />
      </View>
    </Screen>
  );
}
