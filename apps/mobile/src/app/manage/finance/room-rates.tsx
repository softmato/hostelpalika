import { router } from "expo-router";
import { Pencil, Trash2 } from "lucide-react-native";
import { useMemo } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { FactRow } from "@/components/ui/layout";
import { ListRow } from "@/components/ui/list-row";
import { Money } from "@/components/ui/money";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyCard, ErrorState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppTheme } from "@/hooks/use-app-theme";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  BED_TYPE_LABELS,
  type BedType,
  deleteFeeSchedule,
  type FeeSchedule,
  type FeeScheduleData,
} from "@/lib/admin-manage-api";
import { adminQuery, prefetchAdminRoute } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { humanizeEnum } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Room rates — what is charging now, what is booked to start, and the way out of
 * the second.
 *
 * These cards sat at the top of the Finance screen, and the only way to drop
 * rates that had not started was a ghost button at the foot of the *new rates*
 * form — an owner who wanted them gone had to open the screen for making more.
 * Now the not-started card carries its own Change and Delete, where the owner is
 * already looking at the numbers they have changed their mind about.
 *
 * Only a not-started card offers Delete. One that is billing residents is
 * history — an invoice may carry its id — and the server refuses it anyway.
 */

function RateFacts({ schedule }: { schedule: FeeSchedule }) {
  return (
    <View className="gap-1 border-t border-border pt-3">
      {schedule.rates.map((rate) => (
        <FactRow
          key={rate.roomType ?? rate.bedType ?? String(rate.monthlyAmount)}
          label={
            rate.roomType ??
            (rate.bedType
              ? (BED_TYPE_LABELS[rate.bedType as BedType] ?? humanizeEnum(rate.bedType))
              : "Unpriced")
          }
          value={<Money value={rate.monthlyAmount} />}
        />
      ))}
      {schedule.admissionFee ? (
        <FactRow label="Admission" value={<Money value={schedule.admissionFee} />} />
      ) : null}
      {schedule.referralAdmissionDiscount ? (
        <FactRow
          label="Referral discount"
          value={<Money value={schedule.referralAdmissionDiscount} />}
        />
      ) : null}
      {schedule.depositAmount ? (
        <FactRow label="Deposit" value={<Money value={schedule.depositAmount} />} />
      ) : null}
    </View>
  );
}

export default function ManageRoomRatesScreen() {
  const dates = useDates();
  const { colors } = useAppTheme();

  // The same key `finance/rates` and `finance/history` read.
  const query = adminQuery.feeSchedules();
  const schedules = useResource<FeeScheduleData>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const list = useMemo(() => schedules.data?.schedules ?? [], [schedules.data]);
  const current = list.find((schedule) => schedule.standing === "current") ?? null;
  const upcoming = list.find((schedule) => schedule.standing === "upcoming") ?? null;
  const pastCount = list.filter((schedule) => schedule.standing === "past").length;

  const confirmDelete = (schedule: FeeSchedule) =>
    openConfirm({
      confirmLabel: "Delete",
      destructive: true,
      message: `The rates starting ${dates.dateBoth(schedule.effectiveFrom)} have not begun, so nothing was billed from them.${
        current ? " Your current rates carry on." : ""
      }`,
      onConfirm: async () => {
        try {
          await deleteFeeSchedule(schedule._id);
          toastSuccess(
            "Upcoming rates deleted",
            current ? "Your current rates carry on." : undefined,
          );
        } catch (error) {
          toastError("Could not delete them", readApiError(error));
        } finally {
          schedules.refresh();
        }
      },
      title: "Delete upcoming rates?",
    });

  const header = <AppBar accent centerTitle showBack title="Room rates" />;

  if (schedules.loading) {
    return (
      <Screen header={header}>
        <View className="gap-4 pt-1">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={3} />
        </View>
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
      /*
        Changing not-started rates is on their own card, so the footer only
        appears when there is nothing booked — a second "New rates" beside the
        card's "Change" would be two doors into the same form.
      */
      footer={
        upcoming ? undefined : (
          <Button
            label={current ? "New rates" : "Set the rates"}
            onPress={() => router.push("/manage/finance/rates")}
            onPressIn={() => prefetchAdminRoute("/manage/finance/rates")}
          />
        )
      }
      header={header}
      onRefresh={schedules.refresh}
      refreshing={schedules.refreshing}
      scroll
    >
      <View className="gap-3 pt-1">
        {!current && !upcoming ? (
          <EmptyCard
            description="Nobody can be billed until rates are set."
            title="No rates set"
          />
        ) : current ? (
          <Card className="gap-3">
            <View className="flex-row items-center justify-between gap-2">
              <Text variant="label">Charging now</Text>
              <Badge label="Live" tone="success" />
            </View>
            <RateFacts schedule={current} />
          </Card>
        ) : (
          <Card className="gap-2">
            <Text variant="label">No rates are running this month</Text>
            <Text variant="caption">
              Nobody can be billed until rates start. The ones below have not begun
              yet.
            </Text>
          </Card>
        )}

        {upcoming ? (
          <Card className="gap-3">
            <View className="flex-row items-center justify-between gap-2">
              <Text className="flex-1" variant="label">
                {`Starts ${dates.dateBoth(upcoming.effectiveFrom)}`}
              </Text>
              <Badge label="Not started" tone="warning" />
            </View>
            <RateFacts schedule={upcoming} />
            <View className="flex-row gap-2 border-t border-border pt-3">
              <Button
                className="flex-1"
                icon={Pencil}
                label="Change"
                onPress={() => router.push("/manage/finance/rates")}
                size="sm"
                variant="outline"
              />
              {/*
                A soft red, not the solid `danger` variant: the loud red belongs
                to the confirm that actually deletes, not to the button that asks.
              */}
              <Pressable
                accessibilityLabel="Delete the upcoming rates"
                accessibilityRole="button"
                className="h-9 flex-1 flex-row items-center justify-center gap-1.5 rounded-lg bg-destructive/10 active:opacity-70"
                onPress={() => confirmDelete(upcoming)}
              >
                <Trash2 color={colors.destructive} size={16} />
                <Text className="text-sm font-semibold text-destructive" variant={null}>
                  Delete
                </Text>
              </Pressable>
            </View>
          </Card>
        ) : null}

        {pastCount > 0 ? (
          <Card padding="px-4 py-1">
            <ListRow
              icon="time-outline"
              iconBgColor="#8E8E93"
              onPress={() => router.push("/manage/finance/history")}
              subtitle={`${pastCount} earlier set${pastCount === 1 ? "" : "s"} of rates`}
              title="Past rates"
            />
          </Card>
        ) : null}
      </View>
    </Screen>
  );
}
