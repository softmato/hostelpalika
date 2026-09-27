import { detailsTable, type DetailRow } from "../layout";

/** `Rs 1,000` — the way every booking email prints money. */
export function rupees(amount: number) {
  return `Rs ${amount.toLocaleString("en-IN")}`;
}

/** `1 hour`, `12 hours`. */
export function hoursWord(hours: number) {
  return hours === 1 ? "1 hour" : `${hours} hours`;
}

export type BookingFacts = {
  code: string;
  fee: number;
  hostelName: string;
  monthlyRent: number;
  roomType: string;
  /** A short stay's nights, paid beside the fee. */
  stay?: { amount: number; dates: string; nights: number } | null;
  /** Fee plus nights. Absent on a monthly booking, where it is the fee. */
  total?: number;
};

/** What the guest pays: the fee, plus a short stay's nights. */
export function payable(facts: Pick<BookingFacts, "fee" | "total">) {
  return facts.total ?? facts.fee;
}

/** The booking in five rows. `emphasis` picks the one figure the email is about. */
export function bookingFactsTable(
  facts: BookingFacts,
  extra: DetailRow[] = [],
  emphasis: "fee" | null = "fee",
) {
  return detailsTable([
    { label: "Booking", value: facts.code },
    { label: "Hostel", value: facts.hostelName },
    { label: "Room type", value: facts.roomType },
    ...(facts.stay
      ? [
          { label: "Stay", value: `${facts.stay.nights} nights · ${facts.stay.dates}` },
          { label: "Nights", value: rupees(facts.stay.amount) },
          { label: "Booking fee", value: rupees(facts.fee) },
          { emphasis: emphasis === "fee", label: "Total", value: rupees(payable(facts)) },
        ]
      : [
          { label: "Monthly rent", value: rupees(facts.monthlyRent) },
          { emphasis: emphasis === "fee", label: "Booking fee", value: rupees(facts.fee) },
        ]),
    ...extra,
  ]);
}

export type RefundLadderRow = {
  fromDay: number;
  refund: number;
  refundPercent: number;
  throughDay: number;
};

/**
 * The refund policy as rows of rupees, for a booking nobody has confirmed yet.
 * Printed in the invoice email so the terms travel with the money.
 */
export function refundLadderTable(input: {
  fee: number;
  noShowRefund: number;
  rows: RefundLadderRow[];
  /** A short stay's nights: all back until the move-in day, less one night after. */
  stay?: { amount: number; oneNight: number } | null;
}) {
  return detailsTable([
    { label: "Cancel before the hostel says yes", value: rupees(input.fee) },
    { label: "Hostel says no or does not answer", value: rupees(input.fee) },
    ...(input.stay
      ? [
          { label: "Nights, cancelled before the move-in day", value: `${rupees(input.stay.amount)} (all)` },
          {
            label: "Nights, cancelled on the move-in day or never checked in",
            value: `${rupees(input.stay.amount - input.stay.oneNight)} (one night kept)`,
          },
          { label: "Booking fee, after the hostel says yes", value: "As below" },
        ]
      : []),
    ...input.rows.map((row) => ({
      label:
        row.fromDay === row.throughDay
          ? `Cancel on day ${row.fromDay} after the hostel says yes`
          : `Cancel on days ${row.fromDay}–${row.throughDay} after the hostel says yes`,
      value: `${rupees(row.refund)} (${row.refundPercent}%)`,
    })),
    { label: "Never move in", value: rupees(input.noShowRefund) },
  ]);
}
