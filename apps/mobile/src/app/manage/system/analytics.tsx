import { useCallback, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Grid, StatTile } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { SkeletonCard, SkeletonTiles } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { duration, getUsage } from "@/lib/platform-api";

/**
 * Analytics — the existing usage watcher (`/platform/usage`, the web's
 * System › Analytics): opens, time on screens and features used, by role and
 * hostel, or everything for one person.
 */

const RANGES = ["7", "30", "90"] as const;
type View_ = "screens" | "features" | "people" | "groups";

function Bars({ rows }: { rows: { key: string; label: string; share: number; value: string }[] }) {
  if (rows.length === 0) return <EmptyCard description="Nothing recorded in this range." title="No data" />;

  return (
    <Card>
      <View className="gap-3">
        {rows.map((row) => (
          <View className="gap-1" key={row.key}>
            <View className="flex-row justify-between gap-3">
              <Text className="flex-1" numberOfLines={1}>
                {row.label}
              </Text>
              <Text variant="muted">{row.value}</Text>
            </View>
            <View className="h-2 overflow-hidden rounded-full bg-muted">
              <View className="h-2 rounded-full bg-primary" style={{ width: `${Math.max(2, row.share * 100)}%` }} />
            </View>
          </View>
        ))}
      </View>
    </Card>
  );
}

export default function AnalyticsScreen() {
  const dates = useDates();
  const [days, setDays] = useState<(typeof RANGES)[number]>("30");
  const [userId, setUserId] = useState<string | undefined>();
  const [view, setView] = useState<View_>("screens");
  const load = useCallback(() => getUsage(Number(days), userId), [days, userId]);
  const usage = useResource(load, { cacheKey: `platform:usage:${days}:${userId ?? ""}` });
  const data = usage.data;
  const top = (values: (number | undefined)[]) => Math.max(1, ...values.map((n) => n ?? 0));

  return (
    <Screen
      header={<AppBar accent centerTitle showBack title={data?.user ? data.user.name : "Analytics"} />}
      onRefresh={usage.refresh}
      refreshing={usage.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        <Segmented onChange={setDays} options={RANGES.map((range) => ({ label: `${range} days`, value: range }))} value={days} />
        {userId ? <Button icon="arrow-back" label="Everyone" onPress={() => { setUserId(undefined); setView("screens"); }} variant="ghost" /> : null}

        {usage.loading ? (
          <>
            <SkeletonTiles columns={2} />
            <SkeletonCard rows={6} />
          </>
        ) : usage.error || !data ? (
          <ErrorState message={usage.error ?? "Could not load usage."} onRetry={usage.reload} />
        ) : (
          <>
            <Grid maxColumns={2}>
              {[
                <StatTile icon="people" key="users" label="People" value={String(data.totals.users)} />,
                <StatTile icon="phone-portrait" key="opens" label="Opens" value={String(data.totals.opens)} />,
                <StatTile icon="time" key="time" label="Time on screens" value={duration(data.totals.durationMs)} />,
                <StatTile icon="pointer" key="uses" label="Features used" value={String(data.totals.uses)} />,
              ]}
            </Grid>

            <Segmented
              onChange={setView}
              options={[
                { label: "Screens", value: "screens" as const },
                { label: "Features", value: "features" as const },
                { label: userId ? "Recent" : "People", value: "people" as const },
                ...(userId ? [] : [{ label: "Groups", value: "groups" as const }]),
              ]}
              value={view}
            />

            {view === "screens" ? (
              <Bars
                rows={data.screens.map((row) => ({
                  key: row.screen,
                  label: row.screen,
                  share: (row.durationMs ?? 0) / top(data.screens.map((item) => item.durationMs)),
                  value: `${duration(row.durationMs ?? 0)} · ${row.views ?? 0} views`,
                }))}
              />
            ) : null}

            {view === "features" ? (
              <Bars
                rows={data.features.map((row) => ({
                  key: row.feature,
                  label: row.feature,
                  share: (row.uses ?? 0) / top(data.features.map((item) => item.uses)),
                  value: `${row.uses ?? 0} uses`,
                }))}
              />
            ) : null}

            {view === "people" && !userId ? (
              data.users.length === 0 ? (
                <EmptyCard description="Nobody opened the app in this range." title="No people" />
              ) : (
                <Card padding="px-4 py-1">
                  {data.users.map((person, index) => (
                    <View key={person.userId}>
                      {index > 0 ? <RowDivider /> : null}
                      <ListRow
                        onPress={() => setUserId(person.userId)}
                        right={
                          <Text className="text-xs" variant="muted">
                            {person.opens ?? 0} opens
                          </Text>
                        }
                        subtitle={[person.role?.toLowerCase().replace(/_/g, " "), person.hostelName, duration(person.durationMs ?? 0)].filter(Boolean).join(" · ")}
                        title={person.name}
                      />
                    </View>
                  ))}
                </Card>
              )
            ) : null}

            {view === "people" && userId ? (
              data.recent.length === 0 ? (
                <EmptyCard description="Nothing in the last 90 days." title="No activity" />
              ) : (
                <Card padding="px-4 py-1">
                  {data.recent.map((event, index) => (
                    <View key={`${event.at}-${index}`}>
                      {index > 0 ? <RowDivider /> : null}
                      <ListRow
                        subtitle={[dates.dateTime(event.at), event.durationMs ? duration(event.durationMs) : null].filter(Boolean).join(" · ")}
                        title={event.screen ?? event.feature ?? event.kind}
                      />
                    </View>
                  ))}
                </Card>
              )
            ) : null}

            {view === "groups" ? (
              <View className="gap-5">
                <View>
                  <SectionHeader title="By role" />
                  <Bars
                    rows={data.byRole.map((row) => ({
                      key: row.role,
                      label: row.role.toLowerCase().replace(/_/g, " "),
                      share: (row.opens ?? 0) / top(data.byRole.map((item) => item.opens)),
                      value: `${row.users ?? 0} people · ${row.opens ?? 0} opens`,
                    }))}
                  />
                </View>
                <View>
                  <SectionHeader title="By hostel" />
                  <Bars
                    rows={data.byHostel.map((row) => ({
                      key: row.hostelId,
                      label: row.hostelName,
                      share: (row.opens ?? 0) / top(data.byHostel.map((item) => item.opens)),
                      value: `${row.users ?? 0} people · ${row.opens ?? 0} opens`,
                    }))}
                  />
                </View>
              </View>
            ) : null}
          </>
        )}
      </View>
    </Screen>
  );
}
