import { formatBsDate } from "@hostel/calendar/bs";
import { useMemo } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Card } from "@/components/ui/card";
import { FactRow } from "@/components/ui/layout";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useResource } from "@/hooks/use-resource";
import {
  BED_TYPE_LABELS,
  type BedType,
  type FeeScheduleData,
} from "@/lib/admin-manage-api";
import { adminQuery } from "@/lib/admin-queries";
import { humanizeEnum } from "@/lib/format";

/**
 * Past schedules — every set of rates that has stopped, newest first.
 *
 * This was a card sitting under the live rates on the Finance screen, which put
 * last year's prices between an owner and this month's. It is kept because rates
 * are never edited — a closed schedule is how an invoice issued under it can be
 * explained — but that is a question asked rarely, so it is one tap away instead
 * of always on screen.
 *
 * Grouped the way the reference apps group a statement: the date range is the
 * heading **outside** the card, the numbers are the card.
 */

export default function ManageRateHistoryScreen() {
  // The same key `finance/rates` reads — see there.
  const query = adminQuery.feeSchedules();
  const schedules = useResource<FeeScheduleData>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  /*
   * Every set of rates that has finished, newest first.
   *
   * Filtered on `standing`, not on `effectiveTo !== null`. Those are different
   * questions for the month between saving new rates and them starting: the
   * upcoming card has no `effectiveTo` and belongs on the Finance screen, while
   * the card still billing residents does have one and is emphatically not past.
   * Filtering on the date field showed the live rates under History.
   */
  const past = useMemo(
    () =>
      (schedules.data?.schedules ?? [])
        .filter((schedule) => schedule.standing === "past")
        .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)),
    [schedules.data],
  );

  const header = <AppBar accent centerTitle showBack title="Past rates" />;

  if (schedules.loading) {
    return (
      <Screen header={header}>
        <SkeletonCard rows={4} />
      </Screen>
    );
  }

  if (schedules.error) {
    return (
      <Screen header={header}>
        <ErrorState message={schedules.error} onRetry={schedules.reload} />
      </Screen>
    );
  }

  return (
    <Screen
      header={header}
      onRefresh={schedules.refresh}
      refreshing={schedules.refreshing}
      scroll
    >
      {past.length === 0 ? (
        <EmptyCard
          description="Rates you replace are kept here so older invoices still add up."
          title="No past rates yet"
        />
      ) : (
        <View className="gap-4 pt-1">
          {past.map((schedule) => (
            <View className="gap-2" key={schedule._id}>
              <View className="flex-row flex-wrap justify-between gap-x-3 px-0.5">
                <Text variant="label">
                  {`Started ${formatBsDate(new Date(schedule.effectiveFrom))}`}
                </Text>
                <Text variant="label">
                  {schedule.effectiveTo
                    ? `Ended ${formatBsDate(new Date(schedule.effectiveTo))}`
                    : ""}
                </Text>
              </View>

              <Card className="gap-1">
                {schedule.rates.map((rate) => (
                  /*
                   * The room type is the label, because it is the key and it is
                   * the word the owner typed. A card closed before rates were
                   * keyed by room type has only its derived bed type, and that
                   * still has to read as something — history that renders blank
                   * rows is history nobody can audit.
                   */
                  <FactRow
                    key={rate.roomType ?? rate.bedType ?? String(rate.monthlyAmount)}
                    label={
                      rate.roomType ??
                      (rate.bedType
                        ? (BED_TYPE_LABELS[rate.bedType as BedType] ??
                          humanizeEnum(rate.bedType))
                        : "Unpriced")
                    }
                    value={<Money value={rate.monthlyAmount} />}
                  />
                ))}
                {schedule.admissionFee ? (
                  <FactRow label="Admission" value={<Money value={schedule.admissionFee} />} />
                ) : null}
                {schedule.depositAmount ? (
                  <FactRow label="Deposit" value={<Money value={schedule.depositAmount} />} />
                ) : null}
              </Card>
            </View>
          ))}
        </View>
      )}
    </Screen>
  );
}
