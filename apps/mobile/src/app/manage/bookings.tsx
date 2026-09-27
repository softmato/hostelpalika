import { router } from "expo-router";
import { useCallback, useState } from "react";
import { View } from "react-native";

import { PayoutAccountCard } from "@/components/manage/payout-account-card";
import { ShortStaysCard } from "@/components/manage/short-stays-card";
import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { FactRow } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { Segmented } from "@/components/ui/segmented";
import { Sheet } from "@/components/ui/sheet";
import { SkeletonCard } from "@/components/ui/skeleton";
import { EmptyState, FailureState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import {
  answerHostelBooking,
  type HostelBooking,
  type HostelBookings,
  type HostelBookingsTab,
  listHostelBookings,
} from "@/lib/admin-bookings-api";
import { API_BASE_URL } from "@/lib/api";
import { readApiError } from "@/lib/api-contract";
import { openConfirm } from "@/lib/confirm";
import { downloadToDevice } from "@/lib/documents";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * Bookings — docs/BOOKINGS.md item 25.
 *
 * The one decision a hostel makes about a booking, confirm or decline before
 * the answer time runs out, first; then the beds it is holding; then how they
 * ended and what the hostel is owed. The fee was paid to the platform, so there
 * is nothing here to collect.
 */

type Asking = { booking: HostelBooking; mode: "cancel" | "decline" } | null;

/** The API's three lists, plus the payout account this hostel is paid through. */
type ScreenTab = HostelBookingsTab | "settings";

function Facts({ rows }: { rows: [string, string | null | undefined][] }) {
  const shown = rows.filter((row): row is [string, string] => Boolean(row[1]));

  return (
    <View>
      {shown.map(([label, value], index) => (
        <View key={label}>
          {index > 0 ? <RowDivider /> : null}
          <FactRow label={label} value={value} />
        </View>
      ))}
    </View>
  );
}

export default function ManageBookingsScreen() {
  const [tab, setTab] = useState<ScreenTab>("requests");
  const [asking, setAsking] = useState<Asking>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  // Settings is not a list, but the pause notice and what is owed sit above
  // every tab, so it keeps reading the requests one.
  const listTab: HostelBookingsTab = tab === "settings" ? "requests" : tab;
  const list = useResource<HostelBookings>(useCallback(() => listHostelBookings(listTab), [listTab]), {
    cacheKey: `hostel-bookings:${listTab}`,
  });
  const { dateTime } = useDates();
  const header = <AppBar accent centerTitle showBack title="Bookings" />;

  const run = async (booking: HostelBooking, action: "cancel" | "confirm" | "decline", why?: string) => {
    try {
      await answerHostelBooking(booking.id, action, why);
      toastSuccess(
        action === "confirm" ? "Booking confirmed" : action === "decline" ? "Booking declined" : "Booking cancelled",
        action === "confirm" ? "The bed is held." : "The guest is refunded in full.",
      );
    } catch (error) {
      toastError("Not done", readApiError(error, "Try again."));
    } finally {
      list.refresh();
    }
  };

  const confirm = (booking: HostelBooking) =>
    openConfirm({
      confirmLabel: "Confirm booking",
      message: `Holds one ${booking.roomType} bed for ${booking.guest.name}. Admit them by scanning their ID card when they arrive.`,
      onConfirm: () => run(booking, "confirm"),
      title: "Confirm this booking?",
    });

  const closeSheet = () => {
    setAsking(null);
    setReason("");
  };

  const data = list.data;

  const card = (booking: HostelBooking) => (
    <Card key={booking.id}>
      <View className="flex-row items-start justify-between gap-3">
        <View className="flex-1">
          <Text className="text-base font-semibold text-foreground">{booking.guest.name}</Text>
          <Text variant="caption">
            {booking.roomType} · {booking.code}
          </Text>
        </View>
        <Badge
          label={booking.strike ? "Missed booking" : booking.statusLabel}
          tone={booking.strike ? "danger" : booking.status === "CONFIRMED" ? "success" : "neutral"}
        />
      </View>
      <View className="mt-2">
        <Facts
          rows={[
            ["Phone", booking.guest.phone],
            ["Answer by", booking.status === "AWAITING_HOSTEL" ? dateTime(booking.hostelAnswerBy) : null],
            ["Bed held until", booking.status === "CONFIRMED" ? dateTime(booking.holdEndsAt) : null],
            ["Plans to arrive", booking.plannedMoveIn],
            ["Your share after they move in", booking.status === "AWAITING_HOSTEL" ? formatMoney(booking.hostelShareIfKept) : null],
            ["Ended", booking.endedAt ? dateTime(booking.endedAt) : null],
            ["Reason", booking.endReason],
            [
              "Your share",
              booking.payout
                ? `${formatMoney(booking.payout.amount)} · ${booking.payout.status === "SENT" ? `sent ${dateTime(booking.payout.sentAt)}` : "to be sent"}`
                : null,
            ],
          ]}
        />
      </View>

      {booking.status === "AWAITING_HOSTEL" ? (
        <View className="mt-3 flex-row gap-2">
          <Button className="flex-1" label="Decline" onPress={() => setAsking({ booking, mode: "decline" })} variant="outline" />
          <Button className="flex-1" label="Confirm" onPress={() => confirm(booking)} />
        </View>
      ) : null}

      {booking.status === "CONFIRMED" ? (
        <View className="mt-3 gap-2">
          <Button label="Admit by ID card" onPress={() => router.push("/manage/resident/new")} />
          <Button label="Cancel booking" onPress={() => setAsking({ booking, mode: "cancel" })} variant="outline" />
        </View>
      ) : null}

      {booking.payout?.status === "SENT" && booking.payout.documentNumber ? (
        <Button
          className="mt-3"
          label="Payout advice"
          onPress={() => {
            const number = booking.payout?.documentNumber as string;

            void downloadToDevice({
              extension: "pdf",
              fileName: number.replace(/\//g, "-"),
              label: `Payout advice ${number}`,
              mimeType: "application/pdf",
              url: `${API_BASE_URL}/api/v1/hostel-admin/bookings/documents/${encodeURIComponent(number)}`,
            });
          }}
          variant="outline"
        />
      ) : null}
    </Card>
  );

  return (
    <Screen header={header} onRefresh={list.refresh} refreshing={list.refreshing} scroll>
      <View className="gap-5">
        {data?.pause.pausedAt ? (
          <View className="rounded-2xl border border-warning/40 bg-warning/10 p-4">
            <Text className="text-sm text-foreground">
              People cannot book your hostel right now{data.pause.reason ? `: ${data.pause.reason}` : ""}.
            </Text>
          </View>
        ) : null}

        {data ? (
          <Card>
            <Facts
              rows={[
                ["Owed to you", formatMoney(data.owed.due)],
                ["Paid to you", formatMoney(data.owed.sent)],
              ]}
            />
          </Card>
        ) : null}

        <Segmented
          onChange={setTab}
          options={[
            { count: data?.counts.requests, label: "Requests", value: "requests" },
            { count: data?.counts.confirmed, label: "Confirmed", value: "confirmed" },
            { label: "History", value: "history" },
            { label: "Settings", value: "settings" },
          ]}
          value={tab}
        />

        {tab === "settings" ? (
          <View className="gap-3">
            <PayoutAccountCard />
            <ShortStaysCard />
            <Button
              label="How booking works"
              onPress={() => router.push("/legal/how-booking-works")}
              variant="ghost"
            />
          </View>
        ) : list.loading ? (
          <SkeletonCard rows={3} />
        ) : list.error || !data ? (
          <FailureState message={list.error ?? "Bookings could not be loaded."} onRetry={list.reload} />
        ) : data.bookings.length === 0 ? (
          <EmptyState
            compact
            description={
              tab === "requests"
                ? "Nobody is waiting for your answer."
                : tab === "confirmed"
                  ? "No bed is held right now."
                  : "Finished bookings show here."
            }
            icon="calendar-outline"
            title={tab === "requests" ? "No requests" : tab === "confirmed" ? "Nothing held" : "No history yet"}
          />
        ) : (
          <View>
            <SectionHeader title={tab === "requests" ? "Answer these" : tab === "confirmed" ? "Beds held" : "Finished"} />
            <View className="gap-3">{data.bookings.map(card)}</View>
          </View>
        )}
      </View>

      <Sheet
        footer={
          <Button
            disabled={asking?.mode === "cancel" && !reason.trim()}
            label={asking?.mode === "cancel" ? "Cancel booking" : "Decline booking"}
            loading={busy}
            onPress={async () => {
              if (!asking) return;

              setBusy(true);
              await run(asking.booking, asking.mode, reason.trim() || undefined);
              setBusy(false);
              closeSheet();
            }}
          />
        }
        onClose={closeSheet}
        open={asking !== null}
        title={asking?.mode === "cancel" ? "Cancel this booking" : "Decline this booking"}
      >
        <View className="gap-3">
          <Text className="text-sm text-foreground">
            {asking?.mode === "cancel"
              ? "The guest gets the full fee back, and this counts as a missed booking for your hostel."
              : "The guest gets the full fee back. Declining in time does not count against you."}
          </Text>
          <Input
            label={asking?.mode === "cancel" ? "Why" : "Reason (optional)"}
            maxLength={500}
            onChangeText={setReason}
            value={reason}
          />
        </View>
      </Sheet>
    </Screen>
  );
}
