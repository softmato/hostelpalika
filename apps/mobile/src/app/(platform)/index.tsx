import { router } from "expo-router";
import { useMemo } from "react";
import { View } from "react-native";

import { NotificationBell } from "@/components/notification-bell";
import { HealthStrip, SYSTEM_TILES } from "@/components/platform-system";
import { FLOAT_SHADOW } from "@/components/portal-shared";
import { ActionTiles, type ActionTile } from "@/components/ui/action-grid";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { getActiveUsers, listCronJobs, runTone } from "@/lib/platform-api";

/**
 * Platform Home — `PLATFORM_NAV`'s Overview group: who is using the product
 * today on the card pulled up onto the header, the server's health strip, the
 * System tiles (Logs, Process, Cron, Active users, Analytics), and the jobs
 * that need a look (missed, failed or timed out).
 */

const STRADDLE = 34;


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
  const jobs = useResource(listCronJobs, { cacheKey: "platform:cron:jobs" });
  const attention = useMemo(
    () => (jobs.data ?? []).filter((job) => job.missed || job.lastRun?.status === "failed" || job.lastRun?.status === "timeout"),
    [jobs.data],
  );
  const tiles = useMemo<ActionTile[]>(
    () =>
      SYSTEM_TILES.map((tile) => ({
        badge: tile.label === "Cron" && attention.length ? attention.length : undefined,
        glyph: tile.glyph,
        icon: tile.icon,
        key: tile.href,
        label: tile.label,
        onPress: () => router.push(tile.href),
        tone: tile.tone,
      })),
    [attention.length],
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
    <Screen header={header} insideTabs onRefresh={jobs.refresh} refreshing={jobs.refreshing} scroll>
      <View className="gap-5 pt-4">
        <View>
          <SectionHeader title="System" />
          <ActionTiles tiles={tiles} />
        </View>

        <HealthStrip />

        <View>
          <SectionHeader title="Jobs needing a look" />
          {jobs.loading ? (
            <SkeletonRows rows={3} />
          ) : jobs.error ? (
            <Card>
              <Text variant="muted">{jobs.error}</Text>
            </Card>
          ) : attention.length === 0 ? (
            <Card>
              <Text variant="muted">Every job ran on time.</Text>
            </Card>
          ) : (
            <Card padding="px-4 py-1">
              {attention.map((job, index) => (
                <View key={job.name}>
                  {index > 0 ? <RowDivider /> : null}
                  <ListRow
                    icon="timer"
                    onPress={() => router.push("/manage/system/cron")}
                    right={<Badge label={job.missed ? "missed" : job.lastRun!.status} tone={job.missed ? "danger" : runTone(job.lastRun!.status)} />}
                    subtitle={job.lastRun?.error ?? job.schedule ?? undefined}
                    title={job.name}
                  />
                </View>
              ))}
            </Card>
          )}
        </View>
      </View>
    </Screen>
  );
}
