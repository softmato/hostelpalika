import { Types } from "mongoose";
import { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { formatBsDayRange, formatBsPeriod, hostelCalendarDay, hostelPeriodOf } from "@/lib/hostel-day";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { periodBounds } from "@/modules/finance/fee-schedule.service";
import { setAdjustment } from "@/modules/finance/invoice-adjust";
import { getMoneyRules } from "@/modules/finance/money-rules.service";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { ResidentLeaveModel } from "@hostel/db/models/ResidentLeave";
import { ResidentModel } from "@hostel/db/models/Resident";

/**
 * Days a resident was away — home for a festival, a holiday — and what comes
 * off their rent for it (docs/FIELD_FIXES_2026_10.md §9).
 *
 * The hostel decides once what an away day is worth: the **food** for it (a set
 * rupee figure a day — the bed was still theirs), or the **whole day's** rent.
 * Stays shorter than the hostel's minimum earn nothing. The rule is copied onto
 * each entry when it is saved, so changing it later never rewrites an old bill.
 *
 * The money is one `LEAVE` line on that month's rent bill — every entry of the
 * month summed, recomputed whole on each change. A bill already paid gets the
 * same line and the overpayment becomes the resident's credit for next month.
 * A month not billed yet picks the entries up when the billing run makes it.
 */

export const leaveAddSchema = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  hostelId: z.string().optional(),
  note: z.string().trim().max(200).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

type LeaveRow = {
  _id: Types.ObjectId;
  amount: number;
  days: number;
  from: Date;
  mode: "FOOD" | "FULL_DAY";
  note?: string;
  period: string;
  status: string;
  to: Date;
};

const DAY = 24 * 60 * 60 * 1000;
const RENT_BASES = new Set(["SCHEDULE", "OVERRIDE", "MANUAL"]);
const oid = (value: Types.ObjectId | string) => new Types.ObjectId(String(value));
const day = (input: string) => hostelCalendarDay(new Date(`${input}T00:00:00.000Z`));

function serialize(row: LeaveRow) {
  return {
    amount: row.amount,
    days: row.days,
    from: row.from.toISOString().slice(0, 10),
    id: row._id.toString(),
    label: formatBsDayRange(row.from, row.to) || `${row.days} days`,
    mode: row.mode,
    note: row.note ?? null,
    period: row.period,
    periodLabel: formatBsPeriod(row.period) || row.period,
    status: row.status,
    to: row.to.toISOString().slice(0, 10),
  };
}

async function loadResident(hostelId: Types.ObjectId, residentId: string) {
  const resident = await ResidentModel.findOne({ _id: oid(residentId), hostelId, isDeleted: { $ne: true } })
    .select("hostelId moveInDate status")
    .lean<{ _id: Types.ObjectId; hostelId: Types.ObjectId; moveInDate?: Date; status: string } | null>();

  if (!resident) throw new FinanceServiceError("Resident was not found.", "RESIDENT_NOT_FOUND");

  return resident;
}

async function rentBill(hostelId: Types.ObjectId, residentId: Types.ObjectId, period: string) {
  return InvoiceModel.findOne({ hostelId, kind: "MONTHLY_RENT", period, residentId, status: { $ne: "VOID" } })
    .select("lines")
    .lean<{ _id: Types.ObjectId; lines: { adjust?: string; amount: number; basis: string }[] } | null>();
}

/** What one away day takes off: the hostel's food figure, or a day of this bill's rent. */
export function perDayOff(
  rule: { foodPerDay: number; mode: "FOOD" | "FULL_DAY" },
  rent: number,
  billedDays: number,
): number {
  if (rule.mode === "FOOD") return rule.foodPerDay;

  return billedDays > 0 ? rent / billedDays : 0;
}

/** Re-sums a month's away days onto its rent bill, when the bill exists. */
export async function applyLeaveToBill(
  hostelId: Types.ObjectId | string,
  residentId: Types.ObjectId | string,
  period: string,
  principal?: ApiPrincipal,
) {
  const [bill, leaves] = await Promise.all([
    rentBill(oid(hostelId), oid(residentId), period),
    ResidentLeaveModel.find({ period, residentId: oid(residentId), status: "ACTIVE" }).lean<LeaveRow[]>(),
  ]);

  if (!bill) return null;

  const total = leaves.reduce((sum, leave) => sum + leave.amount, 0);
  const days = leaves.reduce((sum, leave) => sum + leave.days, 0);

  await setAdjustment({
    description: `Days away — ${days} ${days === 1 ? "day" : "days"} in ${formatBsPeriod(period) || period}`,
    invoiceId: bill._id,
    kind: "LEAVE",
    principal,
    takeOff: total,
  });
  await ResidentLeaveModel.updateMany(
    { _id: { $in: leaves.map((leave) => leave._id) } },
    { $set: { invoiceId: bill._id } },
  );

  return bill._id;
}

/** Called by the billing run for the residents it just billed. */
export async function applyLeavesAfterBilling(
  hostelId: Types.ObjectId | string,
  period: string,
  residentIds: string[],
) {
  if (residentIds.length === 0) return;

  const waiting = await ResidentLeaveModel.distinct("residentId", {
    hostelId: oid(hostelId),
    period,
    residentId: { $in: residentIds.map(oid) },
    status: "ACTIVE",
  });

  for (const residentId of waiting) {
    await applyLeaveToBill(hostelId, residentId as Types.ObjectId, period);
  }
}

export async function listLeaves(hostelId: Types.ObjectId | string, residentId: string) {
  await connectToDatabase();

  const resident = await loadResident(oid(hostelId), residentId);
  const [rows, rules] = await Promise.all([
    ResidentLeaveModel.find({ residentId: resident._id, status: "ACTIVE" }).sort({ from: -1 }).lean<LeaveRow[]>(),
    getMoneyRules(hostelId),
  ]);

  return { leaves: rows.map(serialize), rule: rules.leave };
}

export async function addLeave(
  hostelId: Types.ObjectId | string,
  residentId: string,
  input: z.infer<typeof leaveAddSchema>,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const id = oid(hostelId);
  const resident = await loadResident(id, residentId);
  const { leave: rule } = await getMoneyRules(id);

  if (!rule.enabled) {
    throw new FinanceServiceError("Turn on Days away in Money rules first.", "LEAVE_OFF");
  }

  const from = day(input.from);
  const to = day(input.to);

  if (to < from) throw new FinanceServiceError("The last day is before the first.", "LEAVE_DATES");

  const period = hostelPeriodOf(from);

  if (hostelPeriodOf(to) !== period) {
    throw new FinanceServiceError(
      `Keep one entry inside ${formatBsPeriod(period) || "one month"}. Add the days in the next month as a second entry.`,
      "LEAVE_CROSSES_MONTH",
    );
  }

  const days = Math.round((to.getTime() - from.getTime()) / DAY) + 1;

  if (days < rule.minDays) {
    throw new FinanceServiceError(`Fewer than ${rule.minDays} days away earn nothing in this hostel.`, "LEAVE_TOO_SHORT");
  }

  const overlap = await ResidentLeaveModel.exists({
    from: { $lte: to },
    residentId: resident._id,
    status: "ACTIVE",
    to: { $gte: from },
  });

  if (overlap) throw new FinanceServiceError("Those days overlap days already entered.", "LEAVE_OVERLAP");

  // A day of rent is this month's bill's own rent over its own days, so a
  // special fee or a part month prices the day right.
  const bill = await rentBill(id, resident._id, period);
  const { daysInMonth, lastDay, start } = periodBounds(period);
  const joined = resident.moveInDate ? hostelCalendarDay(resident.moveInDate) : null;
  const billedFrom = joined && joined > start ? joined : start;
  const billedDays = Math.round((lastDay.getTime() - billedFrom.getTime()) / DAY) + 1;
  const rent = bill
    ? bill.lines.filter((line) => RENT_BASES.has(line.basis) && !line.adjust).reduce((sum, line) => sum + line.amount, 0)
    : 0;

  if (rule.mode === "FULL_DAY" && !bill) {
    throw new FinanceServiceError(
      `${formatBsPeriod(period) || "That month"} is not billed yet. Add these days once its bill is out.`,
      "LEAVE_MONTH_NOT_BILLED",
    );
  }

  const amount = Math.round(perDayOff(rule, rent, bill ? billedDays : daysInMonth) * days);

  await ResidentLeaveModel.create({
    amount,
    createdBy: principal.userId,
    days,
    from,
    hostelId: id,
    mode: rule.mode,
    note: input.note,
    period,
    residentId: resident._id,
    to,
  });
  await applyLeaveToBill(id, resident._id, period, principal);

  return listLeaves(id, residentId);
}

export async function cancelLeave(
  hostelId: Types.ObjectId | string,
  residentId: string,
  leaveId: string,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const id = oid(hostelId);
  const resident = await loadResident(id, residentId);
  const leave = await ResidentLeaveModel.findOneAndUpdate(
    { _id: oid(leaveId), residentId: resident._id, status: "ACTIVE" },
    { $set: { cancelledAt: new Date(), cancelledBy: principal.userId, status: "CANCELLED" } },
    { new: true },
  ).lean<LeaveRow | null>();

  if (!leave) throw new FinanceServiceError("That entry is already gone.", "LEAVE_NOT_FOUND");

  await applyLeaveToBill(id, resident._id, leave.period, principal);

  return listLeaves(id, residentId);
}
