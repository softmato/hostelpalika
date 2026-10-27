import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { formatBsDate, formatBsPeriod, hostelCalendarDay, hostelToday } from "@/lib/hostel-day";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { runBillingCycle } from "@/modules/finance/billing.service";
import {
  type BillingCycle,
  residentPeriodBounds,
  residentPeriodOf,
} from "@/modules/finance/fee-schedule.service";
import { setAdjustment } from "@/modules/finance/invoice-adjust";
import { releaseKhata } from "@/modules/finance/khata.service";
import { HostelSettingsModel } from "@hostel/db/models/HostelSettings";
import { InvoiceBalanceModel } from "@hostel/db/models/InvoiceBalance";
import { InvoiceModel } from "@hostel/db/models/Invoice";

/**
 * The money side of moving somebody out (docs/FIELD_FIXES_2026_10.md §1).
 *
 * Two decisions, both made on the move-out sheet:
 *
 * - **The leaving month**: the whole month (some hostels charge it however
 *   early you leave) or only up to the day. The hostel sets which one the sheet
 *   starts on.
 * - **What is still unpaid**: written off — the hostel has let it go, so it
 *   leaves every total on every screen — or kept as owed.
 *
 * Bills for months after they leave are always cancelled: nobody owes rent for
 * a bed they are not in.
 */

export type LastMonthCharge = "FULL_MONTH" | "TILL_DAY";
export type DuesDecision = "KEEP" | "WRITE_OFF";

type Resident = {
  _id: Types.ObjectId;
  billingCycle?: BillingCycle | null;
  hostelId: Types.ObjectId;
  moveInDate?: Date | null;
};

type OpenInvoice = {
  _id: Types.ObjectId;
  kind: string;
  lines: { adjust?: string; amount: number; basis: string }[];
  period?: string | null;
  status: string;
  totalAmount: number;
};

const UNSETTLED = ["OPEN", "PARTIAL", "OVERDUE"];
const RENT_BASES = new Set(["SCHEDULE", "OVERRIDE", "MANUAL"]);
const DAY = 24 * 60 * 60 * 1000;

const dayNumber = (date: Date) => Math.floor(date.getTime() / DAY);

/** `YYYY-MM-DD` (a Nepal day) → its UTC midnight, the form every date here is kept in. */
export function moveOutDay(input?: string | null): Date {
  if (!input) return hostelToday();

  const day = new Date(`${input}T00:00:00.000Z`);

  return Number.isNaN(day.getTime()) ? hostelToday() : day;
}

export async function defaultLastMonthCharge(hostelId: Types.ObjectId): Promise<LastMonthCharge> {
  const settings = await HostelSettingsModel.findOne({ hostelId })
    .select("moveOutCharge")
    .lean<{ moveOutCharge?: LastMonthCharge } | null>();

  return settings?.moveOutCharge ?? "TILL_DAY";
}

async function settledOn(invoiceIds: Types.ObjectId[]) {
  const rows = await InvoiceBalanceModel.find({ invoiceId: { $in: invoiceIds } })
    .select("invoiceId settledAmount")
    .lean<{ invoiceId: Types.ObjectId; settledAmount?: number }[]>();

  return new Map(rows.map((row) => [row.invoiceId.toString(), row.settledAmount ?? 0]));
}

/**
 * The rent on a bill, before anything was taken off it. Proportioned by days
 * rather than re-priced, so a bill made on an old rate or an override is cut
 * by its own figure, not today's rate card's.
 */
function rentOf(invoice: OpenInvoice) {
  return invoice.lines
    .filter((line) => RENT_BASES.has(line.basis) && !line.adjust)
    .reduce((sum, line) => sum + line.amount, 0);
}

/** Days of the bill keyed `period` the resident was booked for, and how many of those they stayed. */
export function stayDays(resident: Pick<Resident, "billingCycle" | "moveInDate">, period: string, moveOut: Date) {
  const { daysInMonth, lastDay, start } = residentPeriodBounds(resident, period);
  const moveIn = resident.moveInDate;
  const joined = moveIn ? hostelCalendarDay(moveIn) : null;
  const from = joined && joined > start ? joined : start;
  const billed = Math.max(dayNumber(lastDay) - dayNumber(from) + 1, 0);
  const stayed = Math.min(Math.max(dayNumber(moveOut) - dayNumber(from) + 1, 0), billed);

  return { billed, daysInMonth, stayed };
}

/** Whole rupees off a month's rent for the days after `moveOut`. */
export function unusedDaysCut(rent: number, billed: number, stayed: number) {
  if (billed <= 0 || stayed >= billed) return 0;

  return rent - Math.round((rent * stayed) / billed);
}

async function loadRentBills(resident: Resident) {
  return InvoiceModel.find({
    hostelId: resident.hostelId,
    kind: "MONTHLY_RENT",
    residentId: resident._id,
    status: { $ne: "VOID" },
  })
    .select("kind lines period status totalAmount")
    .lean<OpenInvoice[]>();
}

export type MoveOutPreview = {
  date: string;
  dateLabel: string;
  defaultCharge: LastMonthCharge;
  /** The leaving month's rent under each choice. Null when it cannot be priced yet. */
  lastMonth: { FULL_MONTH: number; TILL_DAY: number } | null;
  /** Owed after the move-out, before any write-off, under each choice. */
  owedAfter: { FULL_MONTH: number; TILL_DAY: number };
  /** Money already paid above what they will owe — goes back as credit. */
  paidBack: { FULL_MONTH: number; TILL_DAY: number };
  periodLabel: string;
  stayed: number;
  billedDays: number;
};

/**
 * What the sheet shows before anyone confirms. Read-only.
 *
 * Only bills that exist are counted: a leaving month not billed yet is quoted
 * from the bill it already has where there is one, and otherwise left to the
 * apply step (which bills it through the normal run).
 */
export async function previewMoveOut(
  resident: Resident,
  owedNow: number,
  dateInput?: string | null,
): Promise<MoveOutPreview> {
  const moveOut = moveOutDay(dateInput);
  // The bill whose days hold the move-out — for a same-day resident it may have
  // opened last month.
  const period = residentPeriodOf(resident, moveOut);
  const bills = await loadRentBills(resident);
  const settled = await settledOn(bills.map((bill) => bill._id));
  const days = stayDays(resident, period, moveOut);

  const owing = (bill: OpenInvoice, total = bill.totalAmount) =>
    Math.max(total - (settled.get(bill._id.toString()) ?? 0), 0);

  // Later months are cancelled whatever is chosen.
  const later = bills.filter((bill) => bill.period && bill.period > period);
  const laterOwed = later.reduce((sum, bill) => sum + owing(bill), 0);
  const laterPaid = later.reduce((sum, bill) => sum + (settled.get(bill._id.toString()) ?? 0), 0);

  const leaving = bills.find((bill) => bill.period === period) ?? null;
  const rent = leaving ? rentOf(leaving) : 0;
  const cut = leaving ? unusedDaysCut(rent, days.billed, days.stayed) : 0;
  const leavingOwedNow = leaving ? owing(leaving) : 0;
  // The total as it stands without an earlier move-out line, so a re-preview is honest.
  const leavingFull = leaving
    ? leaving.lines.filter((line) => line.adjust !== "MOVE_OUT").reduce((sum, line) => sum + line.amount, 0)
    : 0;
  const leavingSettled = leaving ? (settled.get(leaving._id.toString()) ?? 0) : 0;

  const after = (choice: LastMonthCharge) => {
    if (!leaving) return { owed: owedNow - laterOwed, paidBack: laterPaid };

    const total = choice === "TILL_DAY" ? leavingFull - cut : leavingFull;
    const owedHere = Math.max(total - leavingSettled, 0);

    return {
      owed: owedNow - laterOwed - leavingOwedNow + owedHere,
      paidBack: laterPaid + Math.max(leavingSettled - total, 0),
    };
  };

  const full = after("FULL_MONTH");
  const tillDay = after("TILL_DAY");

  return {
    billedDays: days.billed,
    date: moveOut.toISOString().slice(0, 10),
    dateLabel: formatBsDate(moveOut),
    defaultCharge: await defaultLastMonthCharge(resident.hostelId),
    lastMonth: leaving ? { FULL_MONTH: rent, TILL_DAY: rent - cut } : null,
    owedAfter: { FULL_MONTH: Math.max(full.owed, 0), TILL_DAY: Math.max(tillDay.owed, 0) },
    paidBack: { FULL_MONTH: full.paidBack, TILL_DAY: tillDay.paidBack },
    periodLabel: formatBsPeriod(period) || period,
    stayed: days.stayed,
  };
}

/** Cancels an unpaid bill without the per-bill "Bill cancelled" push — the move-out notice covers it. */
async function voidQuietly(invoice: OpenInvoice, hostelId: Types.ObjectId, reason: string, principal: ApiPrincipal) {
  await InvoiceModel.updateOne(
    { _id: invoice._id, status: { $ne: "VOID" } },
    {
      $set: {
        status: "VOID",
        updatedBy: principal.userId,
        voidReason: reason,
        voidedAt: new Date(),
        voidedBy: principal.userId,
      },
    },
  );
  await releaseKhata(invoice._id);
  await auditFinanceAction(principal, {
    action: "INVOICE_VOIDED",
    amountAfter: 0,
    amountBefore: invoice.totalAmount,
    entityId: invoice._id,
    entityType: "Invoice",
    hostelId,
    invoiceId: invoice._id.toString(),
    reason,
    source: "MOVE_OUT",
  });
}

/**
 * Takes a bill to nothing: cancelled when nothing was paid on it, cut to what
 * was paid otherwise (the paid part stays a payment for a real bill).
 */
async function clearBill(
  invoice: OpenInvoice,
  hostelId: Types.ObjectId,
  kind: "MOVE_OUT" | "WRITE_OFF",
  description: string,
  settled: number,
  principal: ApiPrincipal,
) {
  if (settled <= 0) {
    await voidQuietly(invoice, hostelId, description, principal);
    return;
  }

  const takeOff =
    kind === "WRITE_OFF"
      ? Math.max(invoice.totalAmount - settled, 0)
      : invoice.lines.filter((line) => line.adjust !== kind).reduce((sum, line) => sum + line.amount, 0);

  await setAdjustment({ description, invoiceId: invoice._id, kind, principal, takeOff });
}

/**
 * Bills the leaving month the chosen way and cancels the months after it.
 * Call after `moveOutDate` and `lastMonthCharge` are saved on the resident.
 */
export async function settleLeavingMonth(
  resident: Resident,
  moveOut: Date,
  charge: LastMonthCharge,
  principal: ApiPrincipal,
) {
  const period = residentPeriodOf(resident, moveOut);
  const label = formatBsDate(moveOut) || moveOut.toISOString().slice(0, 10);
  let bills = await loadRentBills(resident);

  if (!bills.some((bill) => bill.period === period)) {
    // Not billed yet (left before the 1st's run, or joined and left inside one
    // month): the normal run bills it, reading the date and the choice.
    await runBillingCycle({ hostelId: resident.hostelId, period, residentIds: [resident._id] }, principal).catch(
      () => null,
    );
    bills = await loadRentBills(resident);
  }

  const settled = await settledOn(bills.map((bill) => bill._id));
  const leaving = bills.find((bill) => bill.period === period);

  if (leaving) {
    const days = stayDays(resident, period, moveOut);
    const cut = charge === "TILL_DAY" ? unusedDaysCut(rentOf(leaving), days.billed, days.stayed) : 0;

    await setAdjustment({
      description: `Moved out ${label} — ${days.billed - days.stayed} days not charged`,
      invoiceId: leaving._id,
      kind: "MOVE_OUT",
      principal,
      takeOff: cut,
    });
  }

  for (const bill of bills.filter((row) => row.period && row.period > period)) {
    await clearBill(
      bill,
      resident.hostelId,
      "MOVE_OUT",
      `Moved out ${label} — no rent after that`,
      settled.get(bill._id.toString()) ?? 0,
      principal,
    );
  }
}

/**
 * Lets go of everything they still owe. Every unpaid bill — rent, joining,
 * old dues — is cancelled, or cut to what was paid, so it leaves every total:
 * the dashboard's due, Money, Overall and the resident's own statement.
 */
export async function writeOffDues(resident: Resident, principal: ApiPrincipal, reason = "Written off at move-out") {
  const open = await InvoiceModel.find({
    hostelId: resident.hostelId,
    residentId: resident._id,
    status: { $in: UNSETTLED },
  })
    .select("kind lines period status totalAmount")
    .lean<OpenInvoice[]>();
  const settled = await settledOn(open.map((bill) => bill._id));
  let written = 0;

  for (const bill of open) {
    const paid = settled.get(bill._id.toString()) ?? 0;

    written += Math.max(bill.totalAmount - paid, 0);
    await clearBill(bill, resident.hostelId, "WRITE_OFF", reason, paid, principal);
  }

  return written;
}
