import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Card, SectionHeader } from "@/components/ui/card";
import { Grid, StatTile } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard, SkeletonTiles } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { clientLabel, getActiveUsers } from "@/lib/platform-api";

/**
 * Active users — the web's System › Active users: daily, weekly and monthly
 * active people per Kathmandu day, split by role and client (app, PWA, web), and
 * who was active on the day a bar picks.
 */

const split = (counts: Record<string, number>, label: (key: string) => string) =>
  Object.entries(counts)
    .map(([key, n]) => `${label(key)} ${n}`)
    .join(" · ") || "—";

const role = (value: string) => value.toLowerCase().replace(/_/g, " ");

export default function ActiveUsersScreen() {
  const dates = useDates();
  const [day, setDay] = useState<string | undefined>();
  const load = useCallback(() => getActiveUsers(day), [day]);
  const active = useResource(load, { cacheKey: `platform:active-users:${day ?? "today"}` });
  const data = active.data;
  const top = Math.max(1, ...(data?.series.map((row) => row.users) ?? []));
  const chosen = data?.series.find((row) => row.day === data.day);

  return (
    <Screen header={<AppBar accent centerTitle showBack title="Active users" />} onRefresh={active.refresh} refreshing={active.refreshing} scroll>
      <View className="gap-5 pt-1">
        {active.loading ? (
          <>
            <SkeletonTiles columns={3} />
            <SkeletonCard rows={6} />
          </>
        ) : active.error || !data ? (
          <ErrorState message={active.error ?? "Could not load active users."} onRetry={active.reload} />
        ) : (
          <>
            <Grid maxColumns={3}>
              {[
                <StatTile icon="people" key="dau" label={dates.dayMonth(data.day)} value={String(data.dau)} />,
                <StatTile icon="calendar" key="wau" label="7 days" value={String(data.wau)} />,
                <StatTile icon="stats-chart" key="mau" label="30 days" value={String(data.mau)} />,
              ]}
            </Grid>

            <View>
              <SectionHeader subtitle="Tap a day to see who was active" title="Daily active" />
              <Card>
                <View className="h-32 flex-row items-end gap-0.5">
                  {data.series.map((row) => (
                    <Pressable
                      accessibilityLabel={`${row.day}: ${row.users}`}
                      accessibilityRole="button"
                      className={`flex-1 rounded-t ${row.day === data.day ? "bg-primary" : "bg-primary/40"}`}
                      key={row.day}
                      onPress={() => setDay(row.day)}
                      style={{ height: `${Math.max(2, (row.users / top) * 100)}%` }}
                    />
                  ))}
                </View>
                {chosen ? (
                  <Text className="mt-3 text-xs" variant="muted">
                    {split(chosen.byClient, clientLabel)} · {split(chosen.byRole, role)}
                  </Text>
                ) : null}
              </Card>
            </View>

            <View>
              <SectionHeader title={`Who was active on ${dates.dayMonth(data.day)}`} />
              {data.people.length === 0 ? (
                <EmptyCard description="Pick another day on the chart." title="Nobody that day" />
              ) : (
                <Card padding="px-4 py-1">
                  {data.people.map((person, index) => (
                    <View key={person.userId}>
                      {index > 0 ? <RowDivider /> : null}
                      <ListRow
                        right={
                          <Text className="text-xs" variant="muted">
                            {person.opens} opens
                          </Text>
                        }
                        subtitle={[role(person.role), person.hostelName, person.clients.map(clientLabel).join(" · "), `${dates.dateTime(person.firstSeen)} – ${dates.dateTime(person.lastSeen)}`]
                          .filter(Boolean)
                          .join(" · ")}
                        title={person.name || person.userId}
                      />
                    </View>
                  ))}
                </Card>
              )}
            </View>
          </>
        )}
      </View>
    </Screen>
  );
}
