import { router } from "expo-router";
import { useMemo } from "react";
import { View } from "react-native";

import { NotificationBell } from "@/components/notification-bell";
import { HealthStrip, LogRow, SYSTEM_TILES } from "@/components/platform-system";
import { ActionTiles, type ActionTile } from "@/components/ui/action-grid";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonRows } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useResource } from "@/hooks/use-resource";
import { listCronJobs, listLogs, runTone } from "@/lib/platform-api";

/**
 * The superadmin's System tab (owner, 2026-11-09: cron, process and logs get a
 * tab of their own): the server's health strip, the Logs / Process / Cron
 * tiles, the jobs that need a look, and the latest errors. Each opens the full
 * `/manage/system/*` screen.
 */

const LOOK_TILES = SYSTEM_TILES.filter((tile) => ["Logs", "Process", "Cron"].includes(tile.label));

const latestErrors = () => listLogs({ level: "error" });

export default function PlatformSystemScreen() {
  const jobs = useResource(listCronJobs, { cacheKey: "platform:cron:jobs" });
  const errors = useResource(latestErrors, { cacheKey: "platform:logs:errors" });
  const attention = useMemo(
    () => (jobs.data ?? []).filter((job) => job.missed || job.lastRun?.status === "failed" || job.lastRun?.status === "timeout"),
    [jobs.data],
  );
  const tiles = useMemo<ActionTile[]>(
    () =>
      LOOK_TILES.map((tile) => ({
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
  const refresh = () => {
    jobs.refresh();
    errors.refresh();
  };

  return (
    <Screen
      header={<AppBar accent actions={<NotificationBell tone="onAccent" />} large title="System" />}
      insideTabs
      onRefresh={refresh}
      refreshing={jobs.refreshing || errors.refreshing}
      scroll
    >
      <View className="gap-5 pt-4">
        <HealthStrip />

        <ActionTiles tiles={tiles} />

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

        <View>
          <SectionHeader title="Latest errors" />
          {errors.loading ? (
            <SkeletonRows rows={3} />
          ) : !errors.data?.entries.length ? (
            <Card>
              <Text variant="muted">{errors.error ?? "No errors logged."}</Text>
            </Card>
          ) : (
            <Card padding="px-4 py-1">
              {errors.data.entries.slice(0, 8).map((entry, index) => (
                <View key={entry.id}>
                  {index > 0 ? <RowDivider /> : null}
                  <LogRow entry={entry} onPress={() => router.push("/manage/system/logs")} />
                </View>
              ))}
            </Card>
          )}
        </View>
      </View>
    </Screen>
  );
}
