import { router } from "expo-router";
import { useMemo } from "react";
import { View } from "react-native";

import { NotificationBell } from "@/components/notification-bell";
import { HealthStrip, LogRow, SYSTEM_TILES } from "@/components/platform-system";
import { Quiet, Rows, Section, TintRow } from "@/components/platform-ui";
import { ActionTiles, type ActionTile } from "@/components/ui/action-grid";
import { AppBar } from "@/components/ui/app-bar";
import { Screen } from "@/components/ui/screen";
import { SkeletonRows } from "@/components/ui/skeleton";
import { useResource } from "@/hooks/use-resource";
import { listCronJobs, listLogs } from "@/lib/platform-api";

/**
 * The superadmin's System tab (owner, 2026-11-09: cron, process and logs get a
 * tab of their own): the server's health strip, the doors into every system
 * screen plus the audit log, the jobs that need a look, and the latest errors.
 * Flat on the page (owner, 2026-11-17: not boxy).
 */

const latestErrors = () => listLogs({ level: "error" });

export default function PlatformSystemScreen() {
  const jobs = useResource(listCronJobs, { cacheKey: "platform:cron:jobs" });
  const errors = useResource(latestErrors, { cacheKey: "platform:logs:errors" });
  const attention = useMemo(
    () => (jobs.data ?? []).filter((job) => job.missed || job.lastRun?.status === "failed" || job.lastRun?.status === "timeout"),
    [jobs.data],
  );
  const tiles = useMemo<ActionTile[]>(
    () => [
      ...SYSTEM_TILES.map((tile) => ({
        badge: tile.label === "Cron" && attention.length ? attention.length : undefined,
        glyph: tile.glyph,
        icon: tile.icon,
        key: tile.href,
        label: tile.label,
        onPress: () => router.push(tile.href),
        tone: tile.tone,
      })),
      { glyph: "A", icon: "shield-checkmark", key: "/manage/platform/audit-log", label: "Audit log", onPress: () => router.push("/manage/platform/audit-log"), tone: "admin" },
    ],
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
      <View className="gap-7 pt-4">
        <HealthStrip />

        <ActionTiles bare tiles={tiles} />

        <Section count={attention.length} title="Jobs needing a look">
          {jobs.loading ? (
            <SkeletonRows rows={3} />
          ) : jobs.error ? (
            <Quiet icon="alert-circle" tone="danger">
              {jobs.error}
            </Quiet>
          ) : attention.length === 0 ? (
            <Quiet>Every job ran on time.</Quiet>
          ) : (
            <Rows>
              {attention.map((job) => (
                <TintRow
                  icon="timer"
                  key={job.name}
                  onPress={() => router.push("/manage/system/cron")}
                  subtitle={job.lastRun?.error ?? job.schedule ?? undefined}
                  title={job.name}
                  tone="danger"
                  value={job.missed ? "Missed" : job.lastRun!.status}
                />
              ))}
            </Rows>
          )}
        </Section>

        <Section title="Latest errors">
          {errors.loading ? (
            <SkeletonRows rows={3} />
          ) : !errors.data?.entries.length ? (
            <Quiet>{errors.error ?? "No errors logged."}</Quiet>
          ) : (
            <Rows inset={false}>
              {errors.data.entries.slice(0, 8).map((entry) => (
                <LogRow entry={entry} key={entry.id} onPress={() => router.push("/manage/system/logs")} />
              ))}
            </Rows>
          )}
        </Section>
      </View>
    </Screen>
  );
}
