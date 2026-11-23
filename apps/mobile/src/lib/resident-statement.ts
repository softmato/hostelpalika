/**
 * The resident's statement — every rupee that has actually left them, newest
 * first.
 *
 * The mirror of `lib/hostel-statement.ts`, and deliberately thin: everything
 * that filters, searches, groups, ranges or totals a statement lives there and
 * is shared through `StatementRow`. What is here is the part that is genuinely
 * per-side — building rows out of *resident* invoices, and the words.
 *
 * Pure and free of the axios client, same rule as its sibling: Vitest runs
 * node-side with no React Native shim, so the part worth testing is kept out of
 * the screen. `app/(resident)/statement.tsx` is a renderer over these functions.
 *
 * ## Debits only, and it is the same product decision read backwards
 *
 * The hostel's statement is credits because a hostel does not spend through this
 * product. A resident does not *collect* through it either — nobody pays rent to
 * a resident — so their statement is the other single column: money out. An
 * invoice earns a row when `paidAmount > 0` and for no other reason, every
 * amount is a debit, and the direction marker is a constant rather than
 * something to read.
 *
 * An invoice that is merely *raised* is therefore absent, which is the whole
 * difference between this and the Payments tab. Payments answers "what do I owe
 * and how do I pay it"; this answers "what have I actually paid, and when". A
 * resident asked the second question by a parent, a guardian or a landlord, and
 * the Payments tab made them read a list of open months to answer it.
 *
 * ## One invoice is one debit, not one payment
 *
 * The finance view serves invoices, so a month paid in two instalments appears
 * once, at the paid amount, dated by the **last** settlement — `paidDate` is a
 * single field. The detail sheet says `NPR 3,000 of NPR 5,000` in that case
 * rather than implying the month is closed. Same trade the hostel's side takes,
 * for the same reason: inventing two rows out of one would be inventing data.
 *
 * ## There is no truncation here
 *
 * The hostel ledger caps at 5,000 invoices and hides its running totals when it
 * hits that. A resident's own history is a row a month, so the whole of it
 * always arrives and every running total is real.
 *
 * ## Every function that spells a date takes the calendar
 *
 * The resident portal has the same calendar preference the admin one does
 * (`uiSlice.calendarPreference`, through `hooks/use-dates.ts`), so `calendar` is
 * a required argument rather than one defaulting to `"AD"` — a default is
 * exactly how a new call site keeps printing Gregorian while every row around it
 * has moved.
 */

import { type CalendarSystem, formatPeriodIn } from "@/lib/calendar";
import type { ResidentFinanceView, ResidentInvoice } from "@/lib/finance-api";
import { formatMoney } from "@/lib/format";
import {
  byNewestFirst,
  rangeLabel,
  splitByPayment,
  type StatementFilter,
  type StatementRow,
  UNKNOWN_METHOD,
  visibleTotal,
  withRunningTotals,
} from "@/lib/hostel-statement";

/**
 * One debit on the resident's statement.
 *
 * No resident name and no remarks — the statement is theirs, so naming them on
 * every row would be a column of one repeated word, and the remark field is the
 * hostel's own note which this side never sees. What it carries instead is the
 * **reference code**, because that is the one string a resident is ever asked to
 * quote when a payment has to be traced.
 */
export type StatementDebit = StatementRow & {
  /** The code to put in a transfer's remarks. `null` on migrated history. */
  referenceCode: string | null;
};

/**
 * Every debit in the finance view, newest first, with the running total attached.
 *
 * The sort is on `receivedAt` and the running total is accumulated the other way
 * — oldest first — so the two are computed in one pass. Undated debits sort to
 * the end and carry the total as it stood before them, because there is no
 * position in a chronological sum for a row with no date.
 */
export function statementDebits(
  view: ResidentFinanceView | null | undefined,
): StatementDebit[] {
  const invoices = view?.invoices ?? [];

  return withRunningTotals(
    invoices
      .filter((invoice) => invoice.paidAmount > 0)
      .flatMap((invoice) => splitByPayment(toDebit(invoice), invoice.payments))
      .sort(byNewestFirst),
  );
}

function toDebit(invoice: ResidentInvoice): StatementDebit {
  return {
    amount: invoice.paidAmount,
    billed: invoice.dueAmount,
    dueDate: invoice.dueDate ?? null,
    id: invoice.id,
    method: (invoice.method ?? UNKNOWN_METHOD).trim() || UNKNOWN_METHOD,
    period: invoice.month,
    /*
     * `paidDate` only. The hostel's side falls back to `createdAt` — the day the
     * invoice was raised — because its ledger carries one; a resident invoice
     * does not, and there is nothing else on the record that is a claim about
     * when money moved. An undated debit is grouped under "Date not recorded"
     * rather than filed under a day nobody can vouch for.
     */
    receivedAt: invoice.paidDate ?? null,
    referenceCode: invoice.referenceCode?.trim() || null,
    runningTotal: null,
    searchTerms: [invoice.referenceCode?.trim() ?? ""],
    status: invoice.status,
  };
}

/**
 * What a row is called — `Bhadra 2083 rent`.
 *
 * The hostel's version is `Rent from Kartik Adhikari`, because on that side the
 * resident is what distinguishes two rows. On this side every row belongs to the
 * same person, so the month is the whole title — and a one-off says so rather
 * than borrowing a month it does not have: an admission fee carries
 * `period: null`, and every month-keyed reader that assumed otherwise has broken
 * on the first resident a hostel takes.
 */
export function debitTitle(debit: StatementDebit, calendar: CalendarSystem): string {
  return debit.period ? `${formatPeriodIn(calendar, debit.period)} rent` : "One-off charge";
}

/**
 * What the share button sends.
 *
 * Pure and free of `react-native`'s `Share`, the same split the hostel's side
 * takes and for the same reason: Vitest here cannot load that module, and the
 * part worth testing is the words.
 *
 * It describes **what is on screen**, filters included, because that is what the
 * person tapping share is looking at — and the range is stated on its own line
 * rather than implied, since the recipient has no way to tell which they were
 * sent.
 *
 * A summary, never the rows. This lands in a WhatsApp thread to a parent or a
 * guardian; the totals are the answer they asked for, and the invoice ids,
 * reference codes and methods behind them are not theirs to carry. Anyone
 * entitled to the detail can be sent the PDF.
 */
export function residentStatementShareText({
  calendar,
  debits,
  filter,
}: {
  calendar: CalendarSystem;
  debits: readonly StatementDebit[];
  filter: StatementFilter;
}): string {
  const count = debits.length;

  return [
    "My hostel statement",
    rangeLabel(filter, calendar),
    `${count} ${count === 1 ? "payment" : "payments"} · ${formatMoney(visibleTotal(debits))} paid`,
  ].join("\n");
}
