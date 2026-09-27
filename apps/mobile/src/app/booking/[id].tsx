import { Image } from "expo-image";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback } from "react";
import { View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { FactRow } from "@/components/ui/layout";
import { RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { FailureState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { APP_NAME } from "@/constants/branding";
import { API_BASE_URL } from "@/lib/api";
import { readApiError, readApiErrorCode } from "@/lib/api-contract";
import { absoluteMediaUrl } from "@/lib/media";
import {
  type BookingDetail,
  bookingDocumentUrl,
  cancelMyBooking,
  getMyBooking,
  isOpenBooking,
} from "@/lib/booking-api";
import { openConfirm } from "@/lib/confirm";
import { downloadToDevice } from "@/lib/documents";
import { formatMoney } from "@/lib/format";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * One booking — docs/BOOKINGS.md item 23. Where it stands, what happens next
 * and by when, the exact refund if cancelled now, and its papers.
 */

/** `dateTime` from `useDates()`, so every time on the screen follows the calendar the person chose. */
function whatNext(booking: BookingDetail, dateTime: (value: string | null | undefined) => string) {
  switch (booking.status) {
    case "AWAITING_PAYMENT":
      return `Pay ${formatMoney(booking.fee)} and send the screenshot by ${dateTime(booking.paymentDueBy)}.`;
    case "PAYMENT_IN_REVIEW":
      return "We are checking your payment screenshot. You will hear from us as soon as it is checked.";
    case "AWAITING_HOSTEL":
      return `${booking.hostel.name} confirms by ${dateTime(booking.hostelAnswerBy)}. If it declines or does not answer, the full fee comes back.`;
    case "CONFIRMED":
      return `Your bed is held until ${dateTime(booking.holdEndsAt)}. Show your ${APP_NAME} ID card at the hostel to move in.`;
    case "CHECKED_IN":
      return "You have moved in. The booking is complete.";
    default:
      if (!booking.settlement) return "This booking has ended. Nothing was paid.";

      return booking.settlement.refund > 0
        ? `${formatMoney(booking.settlement.refund)} of the fee comes back to ${booking.refundAccount.methodLabel} ${booking.refundAccount.maskedNumber}.`
        : "No refund is due under the refund policy.";
  }
}

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

export default function BookingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const account = useAppSelector((state) => state.auth.account);
  const { dateTime } = useDates();
  const booking = useResource<BookingDetail>(useCallback(() => getMyBooking(id), [id]), {
    cacheKey: `my-booking:${id}`,
  });
  const header = <AppBar showBack title="Booking" />;

  if (booking.loading) {
    return (
      <Screen header={header} scroll>
        <View className="gap-3">
          <SkeletonCard rows={2} />
          <SkeletonCard rows={4} />
        </View>
      </Screen>
    );
  }

  if (booking.error || !booking.data) {
    return (
      <Screen header={header}>
        <FailureState message={booking.error ?? "This booking could not be loaded."} onRetry={booking.reload} />
      </Screen>
    );
  }

  const data = booking.data;

  const cancel = () => {
    const { refund, refundPercent } = data.cancel;

    openConfirm({
      cancelLabel: "Keep booking",
      confirmLabel: "Cancel booking",
      destructive: true,
      message:
        refund > 0
          ? `You get ${formatMoney(refund)} back (${refundPercent}%) to ${data.refundAccount.methodLabel} ${data.refundAccount.maskedNumber}.`
          : data.paymentVerifiedAt
            ? "Nothing is refunded if you cancel now."
            : "Nothing has been paid, so nothing is owed.",
      onConfirm: async () => {
        try {
          await cancelMyBooking(data.id, refund);
          toastSuccess("Booking cancelled");
        } catch (error) {
          const code = readApiErrorCode(error);

          toastError(
            code === "REFUND_CHANGED" ? "The refund changed" : "Could not cancel",
            readApiError(error, "Try again."),
          );
        } finally {
          booking.refresh();
        }
      },
      title: "Cancel this booking?",
    });
  };

  const papers = [
    { kind: "invoice" as const, label: "Invoice", number: data.invoiceNumber },
    { kind: "receipt" as const, label: "Receipt", number: data.receiptNumber },
    { kind: "refund" as const, label: "Refund note", number: data.refund?.documentNumber ?? null },
  ].filter((paper): paper is { kind: "invoice" | "receipt" | "refund"; label: string; number: string } =>
    Boolean(paper.number),
  );

  const cover = absoluteMediaUrl(data.coverPhotoUrl, API_BASE_URL);

  return (
    <Screen header={header} onRefresh={booking.refresh} refreshing={booking.refreshing} scroll>
      <View className="gap-6">
        <Card>
          <View className="flex-row items-start gap-3">
            {cover ? (
              <Image
                accessibilityLabel={data.hostel.name}
                contentFit="cover"
                source={{ uri: cover }}
                style={{ borderRadius: 12, height: 64, width: 64 }}
                transition={150}
              />
            ) : null}
            <View className="flex-1">
              <Text variant="caption">Booking {data.code}</Text>
              <Text className="mt-1 text-xl font-bold text-foreground">{data.statusLabel}</Text>
              <Text className="mt-0.5 text-sm text-muted-foreground">
                {data.roomType} at {data.hostel.name}
              </Text>
            </View>
            <Badge label={isOpenBooking(data.status) ? "Open" : "Ended"} tone={isOpenBooking(data.status) ? "success" : "neutral"} />
          </View>
          <Text className="mt-3 text-sm leading-5 text-foreground">{whatNext(data, dateTime)}</Text>
          {data.status === "AWAITING_PAYMENT" && data.paymentRejection?.reason ? (
            <View className="mt-3 rounded-xl border border-destructive/30 bg-destructive/10 p-3">
              <Text className="text-sm text-destructive">We could not confirm your last screenshot: {data.paymentRejection.reason}</Text>
            </View>
          ) : null}

          <View className="mt-4 gap-2">
            {data.status === "AWAITING_PAYMENT" ? (
              <Button
                label="Pay booking fee"
                onPress={() =>
                  router.push({
                    params: { booking: data.id, room: data.roomType, slug: data.hostel.slug },
                    pathname: "/book/[slug]",
                  })
                }
              />
            ) : null}
            {data.status === "CONFIRMED" ? (
              <Button
                label={account?.userResidentId ? "Show my ID card" : "Create my ID card"}
                onPress={() => router.push("/profile")}
              />
            ) : null}
            {data.cancel.allowed ? (
              <Button
                label={data.cancel.refund > 0 ? `Cancel · ${formatMoney(data.cancel.refund)} back` : "Cancel booking"}
                onPress={cancel}
                variant="outline"
              />
            ) : null}
          </View>
        </Card>

        {data.schedule && data.status === "CONFIRMED" ? (
          <View>
            <SectionHeader title="If you cancel" />
            <Card>
              <Facts
                rows={[
                  ...data.schedule.steps.map((step): [string, string] => [
                    `Before ${dateTime(step.until)}`,
                    `${formatMoney(step.refund)} (${step.refundPercent}%)`,
                  ]),
                  [`Not moved in by ${dateTime(data.schedule.noShow.after)}`, formatMoney(data.schedule.noShow.refund)],
                ]}
              />
            </Card>
          </View>
        ) : null}

        <View>
          <SectionHeader title="Details" />
          <Card>
            <Facts
              rows={[
                ["Monthly rent", formatMoney(data.monthlyRent)],
                ["Booking fee", formatMoney(data.fee)],
                ...(data.stay
                  ? ([
                      ["Stay", `${data.stay.nights} nights · ${data.stay.dates}`],
                      ["Nights", formatMoney(data.stay.amount)],
                      ["Total paid", formatMoney(data.total)],
                    ] as [string, string][])
                  : []),
                ["Refund account", `${data.refundAccount.methodLabel} ${data.refundAccount.maskedNumber}`],
                ["Hostel phone", data.hostel.phone],
                ["Address", data.hostel.address],
                ["Booked", dateTime(data.createdAt)],
                ["Payment checked", data.paymentVerifiedAt ? dateTime(data.paymentVerifiedAt) : null],
                ["Confirmed", data.confirmedAt ? dateTime(data.confirmedAt) : null],
                ["Ended", data.endedAt ? dateTime(data.endedAt) : null],
                ["Refund transaction", data.refund?.transactionId],
              ]}
            />
          </Card>
        </View>

        {papers.length > 0 ? (
          <View>
            <SectionHeader title="Documents" />
            <View className="gap-2">
              {papers.map((paper) => (
                <Button
                  key={paper.kind}
                  label={paper.label}
                  onPress={() =>
                    void downloadToDevice({
                      extension: "pdf",
                      fileName: paper.number.replace(/\//g, "-"),
                      label: `${paper.label} ${paper.number}`,
                      mimeType: "application/pdf",
                      url: bookingDocumentUrl(paper.kind, paper.number),
                    })
                  }
                  variant="outline"
                />
              ))}
            </View>
          </View>
        ) : null}
      </View>
    </Screen>
  );
}
