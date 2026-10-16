import { router } from "expo-router";
import { Fragment, useMemo } from "react";
import { View } from "react-native";

import { NoticeArt } from "@/components/notice-art";
import { AppBar } from "@/components/ui/app-bar";
import { Card, SectionHeader } from "@/components/ui/card";
import { FloatingButton } from "@/components/ui/floating-button";
import { Glyph, type GlyphName } from "@/components/ui/glyph";
import { ListRow } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import type { NoticePush } from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { PUSH_MODES, pushSchedule, sortPushes } from "@/lib/notice-push";

/**
 * Push notices: the list.
 *
 * A notice that goes out on its own — now, later, daily or on chosen weekdays —
 * to residents' phones and the notice board. Rows are grouped by whether they
 * are still going out, heading outside the card; a row opens its own screen
 * for the day and time, rather than a sheet, because timing is the whole job.
 */

const STRADDLE = 34;

const LIFT = {
  elevation: 8,
  shadowColor: "#000000",
  shadowOffset: { height: 6, width: 0 },
  shadowOpacity: 0.13,
  shadowRadius: 16,
} as const;

const GROUPS = [
  { status: "ACTIVE", title: "Running" },
  { status: "PAUSED", title: "Paused" },
  { status: "DONE", title: "Finished" },
] as const;

const MODE_ICON = Object.fromEntries(PUSH_MODES.map((mode) => [mode.value, mode.icon])) as Record<
  NoticePush["repeat"],
  GlyphName
>;

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <View className="flex-1 items-center">
      <Text variant="title">{value}</Text>
      <Text variant="caption">{label}</Text>
    </View>
  );
}

function Tile({ push }: { push: NoticePush }) {
  const { colors } = useAppTheme();
  const tint =
    push.status !== "ACTIVE" ? colors.mutedForeground : push.isUrgent ? colors.warning : colors.primary;

  return (
    <View
      className="h-10 w-10 items-center justify-center rounded-xl"
      style={{ backgroundColor: push.status === "ACTIVE" ? `${tint}1F` : colors.muted }}
    >
      <Glyph color={tint} name={MODE_ICON[push.repeat]} size={20} />
    </View>
  );
}

export default function PushNoticesScreen() {
  const dates = useDates();
  const query = adminQuery.noticePushes();
  const pushes = useResource<NoticePush[]>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });
  const rows = useMemo(() => sortPushes(pushes.data ?? []), [pushes.data]);
  const count = (status: NoticePush["status"]) =>
    rows.filter((push) => push.status === status).length;

  const header = (
    <View className="bg-background">
      <AppBar accent centerTitle showBack straddle={STRADDLE} title="Push notices" />
      <View className="px-4" style={{ marginTop: -STRADDLE }}>
        <View
          className="flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-2"
          style={LIFT}
        >
          <NoticeArt size={68} />
          <Stat label="Running" value={count("ACTIVE")} />
          <Stat label="Paused" value={count("PAUSED")} />
          <Stat label="Sends" value={rows.reduce((total, push) => total + push.runCount, 0)} />
        </View>
      </View>
    </View>
  );

  return (
    <Screen
      floating={
        <FloatingButton
          icon="add"
          label="New push notice"
          onPress={() => router.push("/manage/push-notices/new")}
        />
      }
      header={header}
      onRefresh={pushes.refresh}
      refreshing={pushes.refreshing}
      scroll
    >
      <View className="gap-5 pt-3">
        {pushes.loading ? <SkeletonCard rows={3} /> : null}

        {pushes.error ? <ErrorState message={pushes.error} onRetry={pushes.reload} /> : null}

        {!pushes.loading && !pushes.error && rows.length === 0 ? (
          <EmptyCard description="Tap New push notice to set one up." title="No push notices" />
        ) : null}

        {GROUPS.map((group) => {
          const items = rows.filter((push) => push.status === group.status);

          if (items.length === 0) {
            return null;
          }

          return (
            <View key={group.status}>
              <SectionHeader title={group.title} />
              <Card padding="px-4 py-1">
                {items.map((push, index) => (
                  <Fragment key={push.id}>
                    {index > 0 ? <View className="h-px bg-border" /> : null}
                    <ListRow
                      left={<Tile push={push} />}
                      onPress={() => router.push(`/manage/push-notices/${push.id}`)}
                      subtitle={pushSchedule(push)}
                      title={push.title}
                      value={
                        push.status === "ACTIVE" && push.nextRunAt
                          ? dates.relativeDay(push.nextRunAt)
                          : push.lastRunAt
                            ? dates.relativeDay(push.lastRunAt)
                            : undefined
                      }
                    />
                  </Fragment>
                ))}
              </Card>
            </View>
          );
        })}
      </View>
    </Screen>
  );
}
