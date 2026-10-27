/**
 * Who has not paid, in the order somebody should deal with them.
 *
 * Pure and free of the axios client, same rule as `lib/admin-alerts.ts`: Vitest
 * here runs node-side with no React Native shim, and this is the part of the
 * Money tab worth testing. The screen is a renderer over these functions.
 */

import type { AdminInvoiceRow } from "@/lib/admin-api";

/**
 * What is still owed on a row.
 *
 * Zero for a resident with no invoice — `NOT_BILLED` means nothing has been
 * charged yet, so nothing is *owed* yet even though that row very much needs
 * attention. Clamped at zero because an overpayment (a resident who settled two
 * months in one transfer) would otherwise render as a negative debt.
 */
export function amountOwed(row: AdminInvoiceRow): number {
  const payment = row.payment;

  if (!payment) {
    return 0;
  }

  return Math.max(0, payment.dueAmount - payment.paidAmount);
}

/**
 * Whether this is the resident's **first** month in the hostel.
 *
 * ## Why a row says so
 *
 * The billing run prorates from the move-in day, so somebody admitted on the
 * 17th is billed roughly half a month. On the invoice list that lands as a
 * figure well under everyone else's, on a screen whose entire job is spotting
 * amounts that look wrong — and the honest reading of an unexplained low
 * amount is "somebody was billed incorrectly". An owner then goes looking for a
 * fault that is not there, or worse, "corrects" it.
 *
 * One word on the row removes the question. It is deliberately not a *warning*
 * tone: nothing is wrong, and a badge that pulls the eye would be competing with
 * the overdue pill next to it, which is the thing on this screen that genuinely
 * wants attention.
 *
 * Compared as strings, because `moveInDate` arrives as an ISO instant and the
 * period is `YYYY-MM` — the same test `hostel-admin-payments-page` already makes
 * on the web, and one that cannot drift across a timezone the way two parsed
 * dates could.
 */
export function isFirstMonth(row: AdminInvoiceRow, period: string): boolean {
  return Boolean(row.resident.moveInDate) && row.resident.moveInDate.startsWith(period);
}

/**
 * Whether a first month is a **part** month — the reason the amount is low.
 *
 * A resident admitted on the 1st has a first month too, and theirs is billed in
 * full. Saying "pro-rated" over that invoice would be explaining a discount
 * nobody received, which is a worse error than saying nothing: the figure is
 * correct and the note claims it is not.
 */
export function isProRated(row: AdminInvoiceRow, period: string): boolean {
  return isFirstMonth(row, period) && !row.resident.moveInDate.startsWith(`${period}-01`);
}

/**
 * What the month would cost a resident nobody has invoiced yet.
 *
 * Null unless there is genuinely a figure to show: a row that already has an
 * invoice has `payment` instead, and a resident nothing can price has an amount
 * of `null` from the server, which is not the same as zero. Zero is dropped too
 * — "would be NPR 0" over somebody who moved out mid-month is noise, and
 * {@link notBilledReason} is the half of that row worth reading.
 *
 * Never added to anything. `amountOwed` returns zero for these rows on purpose:
 * this is a projection, and a hostel's outstanding total must not include money
 * nobody has been billed for.
 */
export function projectedAmount(row: AdminInvoiceRow): number | null {
  const amount = row.notBilled?.amount;

  return typeof amount === "number" && amount > 0 ? amount : null;
}

/**
 * Why a row says **Not billed**, as a sentence a warden can act on.
 *
 * The status alone was a dead end. It is what the Money tab shows the day after
 * somebody is registered, and it answers neither of the questions the reader
 * has: how much this person owes for the month, and whether anybody has to do
 * something. Two of these reasons need a person — nothing prices that room type
 * — and the rest are the run simply not having happened yet, or a month the
 * resident genuinely owes nothing for.
 *
 * Plain words, not the server's enum: `NOT_YET_RESIDENT` on a screen is a
 * machine talking to itself. Null for a reason this build does not know, which
 * includes an API older than the field — the row then renders exactly as it did
 * before, rather than printing a code.
 */
export function notBilledReason(row: AdminInvoiceRow): string | null {
  switch (row.notBilled?.reason) {
    case "NOT_YET_RUN":
      return "Not billed yet — the month's billing run has not happened.";
    case "NOT_YET_DUE":
      return "Billed on their own day each month — that day has not come yet.";
    case "BED_TYPE_NOT_PRICED":
    case "FEE_SCHEDULE_MISSING":
      return "Nothing prices this room type — set a rent for it in Finance.";
    case "NOT_YET_RESIDENT":
      return "They move in after this month.";
    case "ALREADY_MOVED_OUT":
      return "They had already moved out.";
    case "NO_BILLABLE_DAYS":
      return "No days of this month are billable.";
    case "PAID_BEFORE_JOINING":
      return "Already paid to the hostel before it joined.";
    case "ZERO_CHARGE":
      return "Their rent is set to zero.";
    default:
      return null;
  }
}

/**
 * The two views the Payments tab switches between.
 *
 * ## Why this is two and was four
 *
 * It was `owing | overdue | unbilled | settled`, drawn as a four-segment control
 * with a count on each. Three of those four counted the *same people twice*:
 * `owing` is every unsettled row and `overdue` and `unbilled` are both subsets
 * of it, so the control read `Owing 23 · Overdue 8 · Unbilled 3 · Paid 17` over
 * a roster of 40 — four numbers that cannot be added up, in the one place on the
 * screen where a reader is entitled to assume the tabs partition the list.
 *
 * Nesting is not something a segmented control can say. What the two subsets
 * were actually for survives without them: **overdue sorts to the top** of the
 * owing list (see `outstandingRows`), every row in that list carries its own
 * status pill, and the section header states both counts as a sentence. The
 * reader gets the same three facts without having to switch views to find them,
 * which is the point — a filter that hides the other twenty people is a worse
 * answer to "who do I chase" than a list that ranks them.
 *
 * `settled` stays because it answers a different question, not a narrower one:
 * "did so-and-so pay". It is deliberately not the default — a screen that opens
 * on the people who *have* paid is a screen that has forgotten what it is for.
 */
export type InvoiceSegment = "owing" | "settled";

/**
 * The rows a segment shows, always in `outstandingRows` order.
 *
 * `settled` sorts by name instead, since there is no outstanding amount to rank
 * those rows by and "did so-and-so pay" is a lookup, not a queue.
 */
export function invoiceSegment(
  rows: readonly AdminInvoiceRow[],
  segment: InvoiceSegment,
): AdminInvoiceRow[] {
  if (segment === "settled") {
    return rows
      .filter((row) => row.displayStatus === "PAID")
      .sort((left, right) => left.resident.fullName.localeCompare(right.resident.fullName));
  }

  return outstandingRows(rows);
}

/**
 * Every row that is not settled — late first, then most owed.
 *
 * ## Overdue leads, and that is the whole of what the Overdue tab did
 *
 * Sorting on the amount alone buried the people the hostel is actually losing
 * money on: a resident three weeks late for NPR 4,000 sat below four residents
 * who are merely unpaid for NPR 9,000 and not yet due. Late is a phone call
 * today and the others are a reminder next week, so late goes first and the
 * amount ranks within each block.
 *
 * Overdue is read from `displayStatus`, not from the due date. The server owns
 * the grace period, and comparing `dueDate` to `Date.now()` here would produce a
 * second, quieter definition that disagrees with the portal on the days either
 * side of the boundary.
 *
 * ## `NOT_BILLED` stays in
 *
 * The obvious filter is "rows with an unpaid invoice", and it hides the worst
 * case: a resident nobody billed at all. Nothing is chasing that, and nothing
 * will — no invoice means no due date, no dunning, no reminder. It sorts to the
 * bottom on amount (it owes nothing yet), which is why the screen also states
 * the count in the section header.
 *
 * ## Ties break on the name
 *
 * Several residents owing exactly one month's rent is the normal case, not an
 * edge case, so without a tiebreak the list reshuffles on every refresh and the
 * row somebody was reaching for moves under their thumb.
 */
export function outstandingRows(rows: readonly AdminInvoiceRow[]): AdminInvoiceRow[] {
  return rows
    .filter((row) => row.displayStatus !== "PAID")
    .sort(
      (left, right) =>
        Number(right.displayStatus === "OVERDUE") - Number(left.displayStatus === "OVERDUE") ||
        amountOwed(right) - amountOwed(left) ||
        left.resident.fullName.localeCompare(right.resident.fullName),
    );
}

/**
 * Free-text search over the invoice rows, client-side.
 *
 * Same argument as `searchResidents` on the roster tab: the matrix this screen
 * already holds is the hostel in full, so filtering what is in hand beats a
 * request per keystroke. Matches name, phone, room number and room type **as one
 * joined string**, so a first name and a room number typed together still find
 * the row, and an empty query returns everything rather than nothing — the field
 * starts empty and must not start by hiding the list.
 *
 * The amount is deliberately not searchable. `8500` would match the room number
 * of nobody and the phone number of somebody, which is the sort of coincidence
 * that makes a search field feel broken.
 */
export function searchInvoiceRows(
  rows: readonly AdminInvoiceRow[],
  query: string,
): AdminInvoiceRow[] {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return [...rows];
  }

  return rows.filter((row) =>
    [row.resident.fullName, row.resident.phone, row.resident.roomNumber, row.resident.roomType]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}
