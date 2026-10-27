import { Types } from "mongoose";
import { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { hostelCalendarDay } from "@/lib/hostel-day";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { HostelSettingsModel } from "@hostel/db/models/HostelSettings";

/**
 * Three small money rules a hostel sets once (docs/FIELD_FIXES_2026_10.md):
 *
 * - **Opening balance** — the bank's closing amount on the day the hostel
 *   started with us, so the statement's running balance matches the bank.
 * - **Leaving month** — charged in full, or only till the move-out day.
 * - **Days away** — what a resident gets off for days at home: the food only,
 *   or the whole day's rent, and the fewest days that count.
 */

export type MoneyRules = {
  leave: { enabled: boolean; foodPerDay: number; minDays: number; mode: "FOOD" | "FULL_DAY" };
  moveOutCharge: "FULL_MONTH" | "TILL_DAY";
  /** Leaving dates must be at least this many days ahead. */
  moveOutNoticeDays: number;
  openingBalance: { amount: number; asOf: string } | null;
};

export const moneyRulesSchema = z.object({
  hostelId: z.string().optional(),
  leave: z
    .object({
      enabled: z.boolean(),
      foodPerDay: z.coerce.number().int().min(0).max(100_000),
      minDays: z.coerce.number().int().min(1).max(31),
      mode: z.enum(["FOOD", "FULL_DAY"]),
    })
    .optional(),
  moveOutCharge: z.enum(["FULL_MONTH", "TILL_DAY"]).optional(),
  moveOutNoticeDays: z.coerce.number().int().min(0).max(90).optional(),
  /** Null clears it. `asOf` is a `YYYY-MM-DD` day. */
  openingBalance: z
    .object({
      amount: z.coerce.number().int().min(-1_000_000_000).max(1_000_000_000),
      asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    })
    .nullable()
    .optional(),
});

type Stored = {
  leave?: Partial<MoneyRules["leave"]>;
  moveOutCharge?: MoneyRules["moveOutCharge"];
  moveOutNoticeDays?: number;
  openingBalance?: { amount: number; asOf: Date } | null;
};

const oid = (value: Types.ObjectId | string) => new Types.ObjectId(String(value));

export async function getMoneyRules(hostelId: Types.ObjectId | string): Promise<MoneyRules> {
  await connectToDatabase();

  const stored = await HostelSettingsModel.findOne({ hostelId: oid(hostelId) })
    .select("leave moveOutCharge moveOutNoticeDays openingBalance")
    .lean<Stored | null>();

  return {
    leave: {
      enabled: stored?.leave?.enabled ?? false,
      foodPerDay: stored?.leave?.foodPerDay ?? 0,
      minDays: stored?.leave?.minDays ?? 3,
      mode: stored?.leave?.mode ?? "FOOD",
    },
    moveOutCharge: stored?.moveOutCharge ?? "TILL_DAY",
    moveOutNoticeDays: stored?.moveOutNoticeDays ?? 0,
    openingBalance: stored?.openingBalance
      ? { amount: stored.openingBalance.amount, asOf: stored.openingBalance.asOf.toISOString().slice(0, 10) }
      : null,
  };
}

export async function saveMoneyRules(
  hostelId: Types.ObjectId | string,
  input: z.infer<typeof moneyRulesSchema>,
  principal: ApiPrincipal,
): Promise<MoneyRules> {
  await connectToDatabase();

  const id = oid(hostelId);
  const set: Record<string, unknown> = { updatedBy: principal.userId };
  const unset: Record<string, ""> = {};

  if (input.leave) set.leave = input.leave;
  if (input.moveOutCharge) set.moveOutCharge = input.moveOutCharge;
  if (input.moveOutNoticeDays !== undefined) set.moveOutNoticeDays = input.moveOutNoticeDays;

  if (input.openingBalance === null) {
    unset.openingBalance = "";
  } else if (input.openingBalance) {
    set.openingBalance = {
      amount: input.openingBalance.amount,
      asOf: hostelCalendarDay(new Date(`${input.openingBalance.asOf}T00:00:00.000Z`)),
      setAt: new Date(),
      setBy: principal.userId,
    };
  }

  const before = input.openingBalance !== undefined ? (await getMoneyRules(id)).openingBalance : null;

  await HostelSettingsModel.updateOne(
    { hostelId: id },
    {
      $set: set,
      ...(Object.keys(unset).length ? { $unset: unset } : {}),
      $setOnInsert: { createdBy: principal.userId },
    },
    { upsert: true },
  );

  // The starting figure of the hostel's own books is money: on the trail.
  if (input.openingBalance !== undefined) {
    await auditFinanceAction(principal, {
      action: "OPENING_BALANCE_SET",
      amountAfter: input.openingBalance?.amount ?? 0,
      amountBefore: before?.amount ?? 0,
      entityId: id,
      entityType: "Hostel",
      hostelId: id,
      reason: input.openingBalance ? `Bank balance on ${input.openingBalance.asOf}` : "Opening balance cleared",
      source: "MONEY_RULES",
    });
  }

  return getMoneyRules(id);
}
