import { useMemo } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { StatusPill } from "@/components/ui/badge";
import { Card, SectionHeader } from "@/components/ui/card";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyState, ErrorState } from "@/components/ui/states";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  groupNightsByMonth,
  type NightHistoryEntry,
  nightDetail,
} from "@/lib/night-status-history";
import { residentQuery } from "@/lib/resident-queries";

/**
 * Your own night status, night by night.
 *
 * `NightStatusLog` was written on every answer and read by nothing, so a
 * resident could tell the hostel where they were every night and never see a
 * word of it back. This is that record: the answer that stood at the end of
 * each night, the nights nobody answered, and which ones hostel staff set.
 *
 * Month headings sit outside the cards and follow the reader's calendar (see
 * `groupNightsByMonth`). Being out is not a warning here either — `StatusPill`
 * keeps `Outside hostel` neutral, as `docs/DESIGN.md` requires.
 */
export default function NightStatusHistoryScreen() {
  const dates = useDates();
  const calendar = dates.calendar;
  const query = residentQuery.nightStatusHistory();
  const history = useResource<NightHistoryEntry[]>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const entries = history.data;
  const months = useMemo(
    () => (entries ? groupNightsByMonth(entries, calendar) : []),
    [calendar, entries],
  );

  const header = <AppBar showBack title="Night status history" />;

  if (history.loading) {
    return (
      <Screen header={header} scroll>
        <View className="pt-1">
          <SkeletonCard rows={6} />
        </View>
      </Screen>
    );
  }

  if (history.error || !entries) {
    return (
      <Screen header={header}>
        <ErrorState
          message={history.error ?? "Your night status history could not be loaded."}
          onRetry={history.reload}
        />
      </Screen>
    );
  }

  return (
    <Screen
      header={header}
      onRefresh={history.refresh}
      refreshing={history.refreshing}
      scroll
    >
      <View className="gap-5 pt-1">
        {months.length === 0 ? (
          <Card>
            <EmptyState
              compact
              description="Answers appear here once you tell your hostel where you are for the night."
              title="No nights yet"
            />
          </Card>
        ) : (
          months.map((month) => (
            <View key={month.period}>
              <SectionHeader title={dates.period(month.period)} />
              <Card>
                {month.entries.map((entry, index) => (
                  <View key={entry.night}>
                    {index > 0 ? <RowDivider /> : null}
                    <ListRow
                      right={<StatusPill status={entry.status} />}
                      subtitle={[
                        nightDetail(entry),
                        entry.answeredAt ? dates.dateTime(entry.answeredAt) : null,
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                      title={dates.dateLong(entry.night)}
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
