import { router } from "expo-router";
import { useMemo, useState } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import type { MoveEvent } from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";

/**
 * Move in / out history — the web portal's move record. The checklists
 * themselves stay on each resident's page; a row opens it.
 */

type Filter = "ALL" | "MOVE_IN" | "MOVE_OUT";

export default function MoveHistoryScreen() {
  const dates = useDates();
  const query = adminQuery.moveHistory();
  const events = useResource<MoveEvent[]>(query.load, { cacheKey: query.key, topics: query.topics });
  const [filter, setFilter] = useState<Filter>("ALL");

  const groups = useMemo(() => {
    const rows = (events.data ?? [])
      .filter((event) => filter === "ALL" || event.type === filter)
      .sort((a, b) => b.date.localeCompare(a.date));
    const byYear = new Map<string, MoveEvent[]>();

    for (const row of rows) {
      const year = dates.year(row.date);

      byYear.set(year, [...(byYear.get(year) ?? []), row]);
    }

    return [...byYear.entries()];
  }, [dates, events.data, filter]);

  const header = <AppBar accent centerTitle showBack title="Move in / out" />;

  return (
    <Screen header={header} onRefresh={events.refresh} refreshing={events.refreshing} scroll>
      <View className="gap-5 pt-1">
        <Segmented
          onChange={setFilter}
          options={[
            { label: "All", value: "ALL" },
            { label: "Moved in", value: "MOVE_IN" },
            { label: "Moved out", value: "MOVE_OUT" },
          ]}
          value={filter}
        />

        {events.loading ? (
          <SkeletonCard rows={5} />
        ) : events.error ? (
          <ErrorState message={events.error} onRetry={events.reload} />
        ) : groups.length === 0 ? (
          <EmptyCard description="Admitting or moving out a resident records it here." title="No moves yet" />
        ) : (
          groups.map(([year, rows]) => (
            <View key={year}>
              <SectionHeader title={year} />
              <Card padding="px-4 py-1">
                {rows.map((event, index) => (
                  <View key={`${event.residentId}-${event.type}-${event.date}`}>
                    {index > 0 ? <RowDivider inset /> : null}
                    <ListRow
                      icon={event.type === "MOVE_IN" ? "log-in-outline" : "log-out-outline"}
                      onPress={() => router.push(`/manage/resident/${event.residentId}`)}
                      right={
                        <Badge
                          label={event.type === "MOVE_IN" ? "In" : "Out"}
                          tone={event.type === "MOVE_IN" ? "success" : "neutral"}
                        />
                      }
                      subtitle={[dates.date(event.date), event.roomType].filter(Boolean).join(" · ")}
                      title={event.residentName}
                    />
                  </View>
                ))}
              </Card>
            </View>
          ))
        )}
      </View>
    </Screen>
  );
}
