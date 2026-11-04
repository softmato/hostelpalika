import { Pressable, View } from "react-native";

import { Badge } from "@/components/ui/badge";
import { Grid, StatTile } from "@/components/ui/layout";
import { SkeletonTiles } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { getHealth, type LogEntry, levelTone, percent, uptime } from "@/lib/platform-api";

/** Pieces the superadmin System screens share: the health strip and one log line. */

export function HealthStrip() {
  const health = useResource(getHealth, { cacheKey: "platform:health" });
  const value = health.data;

  if (health.loading) return <SkeletonTiles columns={3} />;
  if (!value) return null;

  return (
    <Grid maxColumns={3}>
      {[
        <StatTile icon="pulse" key="rpm" label="Requests / min" trend={`up ${uptime(value.uptimeSeconds)}`} value={value.requestsPerMinute.toFixed(1)} />,
        <StatTile icon="timer" key="p95" label="p95" value={`${Math.round(value.p95Seconds * 1000)} ms`} />,
        <StatTile icon="alert-circle" key="err" label="Error rate" tone={value.errorRate > 0.01 ? "danger" : "success"} value={percent(value.errorRate)} />,
        <StatTile icon="server" key="pool" label="Mongo pool" trend={value.mongoCheckoutFailures ? `${value.mongoCheckoutFailures} waits failed` : undefined} value={String(value.mongoPoolInUse)} />,
        <StatTile icon="flash" key="cache" label="Cache hits" value={percent(value.cacheHitRate)} />,
        <StatTile icon="ban" key="rl" label="Rate-limited" value={String(value.rateLimited)} />,
      ]}
    </Grid>
  );
}

export function LogRow({ entry, onPress }: { entry: LogEntry; onPress?: () => void }) {
  const dates = useDates();

  return (
    <Pressable accessibilityRole="button" className="gap-1 py-3 active:opacity-70" disabled={!onPress} onPress={onPress}>
      <View className="flex-row items-center gap-2">
        <Badge label={entry.level} tone={levelTone(entry.level)} />
        <Text className="font-mono text-xs" variant="muted">
          {entry.category}
        </Text>
        {entry.status ? <Text className="font-mono text-xs">{entry.status}</Text> : null}
        <Text className="ml-auto text-xs" variant="muted">
          {dates.dateTime(entry.at)}
        </Text>
      </View>
      <Text numberOfLines={2}>{entry.message}</Text>
    </Pressable>
  );
}

/** The System children of `PLATFORM_NAV`'s Overview group, as Home tiles and More rows. */
export const SYSTEM_TILES = [
  { glyph: "L", href: "/manage/system/logs", icon: "document-text", label: "Logs", tone: "brand" },
  { glyph: "P", href: "/manage/system/process", icon: "hardware-chip", label: "Process", tone: "brand" },
  { glyph: "C", href: "/manage/system/cron", icon: "timer", label: "Cron", tone: "warning" },
  { glyph: "A", href: "/manage/system/active-users", icon: "people", label: "Active users", tone: "success" },
  { glyph: "U", href: "/manage/system/analytics", icon: "stats-chart", label: "Analytics", tone: "success" },
] as const;
