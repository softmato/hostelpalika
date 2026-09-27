import { Image } from "expo-image";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { router, useLocalSearchParams } from "expo-router";
import { useCallback, useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "@/components/ui/app-bar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, SectionHeader } from "@/components/ui/card";
import { ChoiceChips } from "@/components/ui/choice-chips";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { FactRow } from "@/components/ui/layout";
import { ListRow, RowDivider } from "@/components/ui/list-row";
import { Screen } from "@/components/ui/screen";
import { SkeletonCard } from "@/components/ui/skeleton";
import { StackedThumb } from "@/components/ui/stacked-thumb";
import { EmptyState, FailureState } from "@/components/ui/states";
import { Text } from "@/components/ui/text";
import { useAppSelector } from "@/hooks/redux";
import { useDates } from "@/hooks/use-dates";
import { useResource } from "@/hooks/use-resource";
import { APP_NAME } from "@/constants/branding";
import { API_BASE_URL } from "@/lib/api";
import { readApiError, readApiErrorCode } from "@/lib/api-contract";
import { openAssetViewer } from "@/lib/asset-viewer";
import {
  type BookingAvailability,
  type BookingDetail,
  type BookingQuote,
  createBooking,
  getBookingAvailability,
  getBookingQuote,
  confirmBookingReturn,
  getMyBooking,
  openBookingCheckout,
  type RefundMethod,
} from "@/lib/booking-api";
import { formatMoney } from "@/lib/format";
import { absoluteMediaUrl } from "@/lib/media";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * The checkout — docs/BOOKINGS.md item 22.
 *
 * A package card first (what is being bought never changes), then the one next
 * step: choose a room, sign in, details and refund account and the policy tick,
 * pay and send the screenshot, then the live status. The booking id goes into
 * the route as soon as it exists, so leaving and coming back lands on the same
 * step.
 */

const METHODS: readonly { label: string; value: RefundMethod }[] = [
  { label: "eSewa", value: "ESEWA" },
  { label: "Khalti", value: "KHALTI" },
  { label: "Bank", value: "BANK" },
];

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

/** Absolute URLs for a room's own photos, in order. */
function roomPhotoUris(photos: readonly string[]) {
  return photos
    .map((url) => absoluteMediaUrl(url, API_BASE_URL))
    .filter((url): url is string => Boolean(url));
}

/**
 * The room being booked, in its own photos, under the hostel's cover. Tapping
 * one opens the app's asset viewer, the same as on the hostel screen — a bed is
 * worth looking at properly before it is paid for.
 */
function RoomPhotos({ photos, roomType }: { photos: string[]; roomType: string }) {
  if (photos.length === 0) {
    return null;
  }

  return (
    <View className="mt-3 border-t border-border pt-3">
      <Text variant="caption">{roomType}</Text>
      <View className="mt-2 flex-row flex-wrap gap-2">
        {photos.map((uri, index) => (
          <Pressable
            accessibilityLabel={`${roomType} photo ${index + 1}`}
            accessibilityRole="imagebutton"
            key={uri}
            onPress={() => openAssetViewer(photos.map((url) => ({ title: roomType, url })), index)}
          >
            <Image
              contentFit="cover"
              source={{ uri }}
              style={{ borderRadius: 10, height: 72, width: 72 }}
              transition={150}
            />
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function PackageCard({ quote }: { quote: BookingQuote }) {
  const cover = absoluteMediaUrl(quote.hostel.coverPhotoUrl, API_BASE_URL);
  const photos = roomPhotoUris(quote.room.photos);

  return (
    <Card padding="p-0">
      {cover ? (
        <Image
          accessibilityLabel={quote.hostel.name}
          contentFit="cover"
          source={{ uri: cover }}
          style={{ aspectRatio: 16 / 9, borderTopLeftRadius: 16, borderTopRightRadius: 16, width: "100%" }}
        />
      ) : null}
      <View className="p-4">
        <Text className="text-lg font-bold text-foreground">{quote.hostel.name}</Text>
        {quote.hostel.address ? <Text variant="caption">{quote.hostel.address}</Text> : null}
        <View className="mt-2">
          <Facts
            rows={[
              ["Room type", quote.room.roomType],
              ["Monthly rent", quote.room.monthlyRent ? formatMoney(quote.room.monthlyRent) : null],
              ["Hostel answers within", `${quote.terms.hostelAnswerHours} hours`],
              ["Bed held for", `${quote.terms.holdDays} days`],
            ]}
          />
        </View>
        <RoomPhotos photos={photos} roomType={quote.room.roomType} />
        <View className="mt-3 flex-row items-end justify-between border-t border-border pt-3">
          <View>
            <Text className="text-sm font-semibold text-foreground">Booking fee</Text>
            <Text variant="caption">{quote.terms.feePercent}% of one month&apos;s rent</Text>
          </View>
          <Text className="text-2xl font-bold text-foreground">{formatMoney(quote.fee)}</Text>
        </View>
        <Text className="mt-2" variant="caption">
          Paid to {APP_NAME}. Rent, admission fee and deposit are paid to the hostel.
        </Text>
      </View>
    </Card>
  );
}

function RoomChooser({ availability, slug }: { availability: BookingAvailability | null; slug: string }) {
  if (!availability) {
    return <SkeletonCard rows={3} />;
  }

  const rooms = availability.rooms.filter((room) => room.bookable);

  if (rooms.length === 0) {
    return <EmptyState description="No room at this hostel can be booked right now." icon="bed-outline" title="Nothing to book" />;
  }

  return (
    <View>
      <SectionHeader title="Choose a room" />
      <Card padding="px-4 py-1">
        {rooms.map((room) => {
          const photos = roomPhotoUris(room.photos);

          return (
            <ListRow
              icon="bed-outline"
              key={room.roomType}
              left={photos.length > 0 ? <StackedThumb photos={photos} /> : undefined}
              onPress={() => router.setParams({ room: room.roomType, slug })}
              subtitle={`${formatMoney(room.fee)} booking fee`}
              title={room.roomType}
            />
          );
        })}
      </Card>
    </View>
  );
}

type StayDates = { moveIn: string; moveOut: string };

const DAY_INPUT = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Monthly or a short stay. A short stay types its dates (the same YYYY-MM-DD
 * field the intake uses) and is re-quoted as they change.
 */
function StayPicker({
  dates,
  onDates,
  onShortStay,
  quote,
  shortStay,
}: {
  dates: StayDates;
  onDates: (next: StayDates) => void;
  onShortStay: (next: boolean) => void;
  quote: BookingQuote;
  shortStay: boolean;
}) {
  const offer = quote.shortStay;

  if (!offer?.available || !offer.limits) return null;

  return (
    <View className="gap-3">
      <Segmented
        onChange={(value) => onShortStay(value === "short")}
        options={[
          { label: "Monthly", value: "monthly" },
          { label: `Short stay · ${formatMoney(offer.dailyRate)}/night`, value: "short" },
        ]}
        value={shortStay ? "short" : "monthly"}
      />
      {shortStay ? (
        <Card className="gap-3">
          <Input
            hint={`Up to ${offer.limits.maxAdvanceDays} days ahead`}
            keyboardType="numbers-and-punctuation"
            label="Move in"
            onChangeText={(moveIn) => onDates({ ...dates, moveIn })}
            placeholder="YYYY-MM-DD"
            value={dates.moveIn}
          />
          <Input
            hint={`${offer.limits.minNights}–${offer.limits.maxNights} nights`}
            keyboardType="numbers-and-punctuation"
            label="Move out"
            onChangeText={(moveOut) => onDates({ ...dates, moveOut })}
            placeholder="YYYY-MM-DD"
            value={dates.moveOut}
          />
          {offer.error ? <Text className="text-sm text-destructive">{offer.error.message}</Text> : null}
          {offer.quote ? (
            <Facts
              rows={[
                ["Nights", `${offer.quote.nights} × ${formatMoney(offer.dailyRate)} = ${formatMoney(offer.quote.stayAmount)}`],
                [
                  "Booking fee",
                  offer.quote.holdBlocks > 1
                    ? `${formatMoney(offer.quote.fee)} (${offer.quote.holdBlocks} weeks held)`
                    : formatMoney(offer.quote.fee),
                ],
                ["Total, paid now", formatMoney(offer.quote.total)],
              ]}
            />
          ) : null}
        </Card>
      ) : null}
    </View>
  );
}

function BookingForm({
  onBooked,
  onPolicyChanged,
  quote,
  stay,
}: {
  onBooked: (booking: BookingDetail) => void;
  onPolicyChanged: () => void;
  quote: BookingQuote;
  /** A chosen short stay: its priced dates, or "unpriced" until they are. */
  stay: (StayDates & { total: number }) | null | "unpriced";
}) {
  const priced = stay && stay !== "unpriced" ? stay : null;
  const account = useAppSelector((state) => state.auth.account);
  const [method, setMethod] = useState<RefundMethod>("ESEWA");
  const [holderName, setHolderName] = useState(account?.name ?? "");
  const [number, setNumber] = useState("");
  const [bankName, setBankName] = useState("");
  const [branch, setBranch] = useState("");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const policy = quote.policy;

  const submit = async () => {
    if (!accepted) {
      toastError("Accept the refund policy to book");
      return;
    }

    setBusy(true);

    try {
      onBooked(
        await createBooking({
          hostel: quote.hostel.slug,
          ...(priced ? { kind: "SHORT_STAY" as const, moveIn: priced.moveIn, moveOut: priced.moveOut } : {}),
          policyVersion: quote.policyVersion,
          refundAccount: { bankName, branch, holderName, method, number },
          roomType: quote.room.roomType,
        }),
      );
    } catch (error) {
      if (readApiErrorCode(error) === "BOOKING_POLICY_CHANGED") {
        setAccepted(false);
        onPolicyChanged();
      }

      toastError("Could not book", readApiError(error, "Try again."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className="gap-6">
      <View>
        <SectionHeader subtitle="Where any refund of the booking fee is sent" title="Refund account" />
        <Card>
          <View className="gap-3">
            <ChoiceChips columns={3} onToggle={setMethod} options={METHODS} value={method} />
            <Input label="Name on the account" onChangeText={setHolderName} value={holderName} />
            {method === "BANK" ? (
              <>
                <Input label="Bank" onChangeText={setBankName} value={bankName} />
                <Input label="Branch (optional)" onChangeText={setBranch} value={branch} />
              </>
            ) : null}
            <Input
              keyboardType={method === "BANK" ? "default" : "number-pad"}
              label={method === "BANK" ? "Account number" : "Mobile number on the wallet"}
              onChangeText={setNumber}
              value={number}
            />
          </View>
        </Card>
      </View>

      {policy && quote.fee ? (
        <View>
          <SectionHeader title="Refunds" />
          <Card>
            <Facts
              rows={[
                ["Cancel before the hostel confirms", formatMoney(quote.fee)],
                ["Hostel declines or does not answer", formatMoney(quote.fee)],
                ...policy.rows.map((row): [string, string] => [
                  row.fromDay === row.throughDay ? `Cancel on day ${row.fromDay}` : `Cancel on days ${row.fromDay}–${row.throughDay}`,
                  `${formatMoney(row.refund)} (${row.refundPercent}%)`,
                ]),
                [`Not moved in within ${policy.holdDays} days`, formatMoney(policy.noShowRefund)],
              ]}
            />
            <Pressable
              accessibilityRole="checkbox"
              accessibilityState={{ checked: accepted }}
              className="mt-3 flex-row items-center gap-3"
              onPress={() => setAccepted((value) => !value)}
            >
              <View
                className={`h-6 w-6 items-center justify-center rounded-md border ${accepted ? "border-primary bg-primary" : "border-border"}`}
              >
                {accepted ? <Text className="text-xs font-bold text-primary-foreground">✓</Text> : null}
              </View>
              <Text className="flex-1 text-sm text-foreground">I accept the refund policy</Text>
            </Pressable>
            <Button className="mt-2" label="Read the refund policy" onPress={() => router.push("/legal/refund-policy")} size="sm" variant="ghost" />
            <Button label="How booking works" onPress={() => router.push("/legal/how-booking-works")} size="sm" variant="ghost" />
          </Card>
        </View>
      ) : null}

      <Button
        disabled={stay === "unpriced"}
        label={stay === "unpriced" ? "Pick your dates" : `Book and pay ${formatMoney(priced ? priced.total : quote.fee)}`}
        loading={busy}
        onPress={() => void submit()}
      />
    </View>
  );
}

function PayStep({ booking, onChange }: { booking: BookingDetail; onChange: (booking: BookingDetail) => void }) {
  const pay = booking.pay!;
  const dates = useDates();
  const [stage, setStage] = useState<"idle" | "opening" | "confirming">("idle");

  /*
   * Softmato checkout in an in-app browser sheet — the app stays underneath.
   * Its return page hands back to `hostelpalika://checkout/return`, and the
   * app (which is signed in; the sheet is not) asks the server what happened.
   * Asked even when the sheet was closed: they may have paid anyway.
   */
  const payNow = async () => {
    setStage("opening");

    try {
      const checkoutUrl = await openBookingCheckout(booking.id);

      await WebBrowser.openAuthSessionAsync(checkoutUrl, Linking.createURL("checkout/return"));
      setStage("confirming");

      const state = await confirmBookingReturn(booking.id);

      onChange(await getMyBooking(booking.id));

      if (state.kind === "booking_paid") {
        toastSuccess("Booking fee received", "We will email you your receipt shortly.");
      } else if (state.kind === "booking_refund") {
        toastSuccess("Payment refunded", "It arrived after the booking ended, so the full amount is coming back.");
      } else if (state.kind === "pending_document") {
        toastSuccess("Still confirming", "This booking updates as soon as Softmato confirms.");
      }
    } catch (error) {
      toastError("Could not complete it", readApiError(error, "Try again."));
    } finally {
      setStage("idle");
    }
  };

  return (
    <View className="gap-6">
      {booking.paymentRejection?.reason ? (
        <View className="rounded-xl border border-destructive/30 bg-destructive/10 p-3">
          <Text className="text-sm text-destructive">We could not confirm your last payment: {booking.paymentRejection.reason}</Text>
        </View>
      ) : null}

      <View>
        <SectionHeader title="Pay the booking fee" />
        <Card>
          <Facts
            rows={[
              ["Amount", formatMoney(pay.amount)],
              ["Pay by", dates.dateTime(pay.payBy)],
              ["Booking", pay.reference],
            ]}
          />
          <Text className="mt-3 text-xs leading-5 text-muted-foreground">
            You will finish paying on Softmato, our company&apos;s secure checkout, and come straight back here.
          </Text>
          <Button
            className="mt-4"
            label={stage === "confirming" ? "Confirming your payment…" : `Pay ${formatMoney(pay.amount)}`}
            loading={stage !== "idle"}
            onPress={() => void payNow()}
          />
        </Card>
      </View>
    </View>
  );
}

function StatusCard({ booking }: { booking: BookingDetail }) {
  const dates = useDates();

  return (
    <Card>
      <View className="flex-row items-center justify-between gap-3">
        <Text variant="caption">Booking {booking.code}</Text>
        <Badge label={booking.statusLabel} tone="success" />
      </View>
      <Text className="mt-2 text-sm leading-5 text-foreground">
        {booking.status === "PAYMENT_IN_REVIEW"
          ? "We are checking your payment."
          : booking.status === "AWAITING_HOSTEL"
            ? `Payment received. ${booking.hostel.name} confirms by ${dates.dateTime(booking.hostelAnswerBy)}.`
            : booking.status === "CONFIRMED"
              ? `Your bed is held until ${dates.dateTime(booking.holdEndsAt)}.`
              : booking.statusLabel}
      </Text>
      <Button
        className="mt-3"
        label="View booking"
        onPress={() => router.replace({ params: { id: booking.id }, pathname: "/booking/[id]" })}
        variant="outline"
      />
    </Card>
  );
}

export default function CheckoutScreen() {
  const params = useLocalSearchParams<{ booking?: string; room?: string; slug: string }>();
  const account = useAppSelector((state) => state.auth.account);
  const [booking, setBooking] = useState<BookingDetail | null>(null);
  const room = params.room?.trim() || null;
  const bookingId = booking?.id ?? params.booking ?? null;
  const [shortStay, setShortStay] = useState(false);
  const [dates, setDates] = useState<StayDates>({ moveIn: "", moveOut: "" });
  const priceIn = shortStay && DAY_INPUT.test(dates.moveIn) && DAY_INPUT.test(dates.moveOut) ? dates.moveIn : "";
  const priceOut = priceIn ? dates.moveOut : "";

  const availability = useResource<BookingAvailability>(
    useCallback(() => getBookingAvailability(params.slug), [params.slug]),
    { cacheKey: `booking-availability:${params.slug}` },
  );
  const quote = useResource<BookingQuote | null>(
    useCallback(
      () =>
        room
          ? getBookingQuote(params.slug, room, Boolean(account), priceIn ? { moveIn: priceIn, moveOut: priceOut } : null)
          : Promise.resolve(null),
      [account, params.slug, priceIn, priceOut, room],
    ),
    { cacheKey: `booking-quote:${params.slug}:${room ?? ""}:${account ? "in" : "out"}:${priceIn}:${priceOut}` },
  );
  const existing = useResource<BookingDetail | null>(
    useCallback(
      () => (params.booking && account ? getMyBooking(params.booking) : Promise.resolve(null)),
      [account, params.booking],
    ),
    { cacheKey: `checkout-booking:${params.booking ?? ""}` },
  );

  const current = booking ?? existing.data ?? null;
  const header = <AppBar showBack title="Book a room" />;

  if (!room) {
    return (
      <Screen header={header} scroll>
        <RoomChooser availability={availability.data ?? null} slug={params.slug} />
      </Screen>
    );
  }

  if ((quote.loading && !quote.data) || (bookingId && existing.loading && !booking)) {
    return (
      <Screen header={header} scroll>
        <View className="gap-3">
          <SkeletonCard rows={3} />
          <SkeletonCard rows={4} />
        </View>
      </Screen>
    );
  }

  if (quote.error || !quote.data) {
    return (
      <Screen header={header}>
        <FailureState message={quote.error ?? "This room could not be loaded."} onRetry={quote.reload} />
      </Screen>
    );
  }

  const data = quote.data;
  let step;

  if (current) {
    step =
      current.status === "AWAITING_PAYMENT" && current.pay ? (
        <PayStep booking={current} onChange={setBooking} />
      ) : (
        <StatusCard booking={current} />
      );
  } else if (!data.available) {
    step = <EmptyState compact description={data.reasonMessage ?? "This room cannot be booked right now."} icon="bed-outline" title="Not bookable" />;
  } else if (data.openBooking) {
    step = (
      <Card>
        <Text className="text-sm text-foreground">
          You already have an open booking ({data.openBooking.code} at {data.openBooking.hostelName}). Finish or cancel it
          before booking another room.
        </Text>
        <Button
          className="mt-3"
          label="Open that booking"
          onPress={() => router.push({ params: { id: data.openBooking!.id }, pathname: "/booking/[id]" })}
        />
      </Card>
    );
  } else if (!account) {
    step = (
      <Card>
        <Text className="text-sm text-foreground">Sign in to book. The booking, its receipt and any refund belong to your account.</Text>
        <Button className="mt-3" label="Sign in" onPress={() => router.push("/(browse)/profile")} />
      </Card>
    );
  } else {
    step = (
      <BookingForm
        stay={
          !shortStay
            ? null
            : data.shortStay?.quote && priceIn && data.shortStay.quote.moveIn === priceIn && data.shortStay.quote.moveOut === priceOut
              ? { moveIn: priceIn, moveOut: priceOut, total: data.shortStay.quote.total }
              : "unpriced"
        }
        onBooked={(created) => {
          setBooking(created);
          router.setParams({ booking: created.id });
        }}
        onPolicyChanged={quote.refresh}
        quote={data}
      />
    );
  }

  return (
    <Screen header={header} scroll>
      <View className="gap-6">
        <PackageCard quote={data} />
        {!current ? (
          <StayPicker dates={dates} onDates={setDates} onShortStay={setShortStay} quote={data} shortStay={shortStay} />
        ) : null}
        {step}
      </View>
    </Screen>
  );
}
