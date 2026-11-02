import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { assertWholeRupees } from "@/modules/finance/money";
import { ResidentModel } from "@hostel/db/models/Resident";

/**
 * The per-resident fee override (target §3.3, plan item 2.8).
 *
 * Ports `setResidentMonthlyFee` off `payment.service`. Same job — set
 * `Resident.monthlyFee` for one, several, or every active resident — with two
 * differences that matter now that a fee schedule exists:
 *
 * **`null` is a real value here, and it means "use the schedule".** The old
 * signature could only ever write a number, so once a resident had a fee there
 * was no way back to the rate card except through the database. That is the
 * operation the fee-schedule editor needs most.
 *
 * **Zero is not null.** `resolveMonthlyCharge` tests for null rather than
 * falsiness precisely so a deliberate zero — a staff member's child — survives;
 * writing zero here keeps that meaning rather than silently handing the resident
 * back to the schedule.
 */

export type SetResidentFeeInput = {
  hostelId: Types.ObjectId | string;
  /** Null hands the resident back to the fee schedule. */
  monthlyFee: number | null;
  reason?: string;
  /** Absent means every active resident in the hostel. */
  residentIds?: string[];
};

export async function setResidentMonthlyFee(
  input: SetResidentFeeInput,
  principal: ApiPrincipal,
): Promise<{ monthlyFee: number | null; updatedCount: number }> {
  await connectToDatabase();

  if (input.monthlyFee !== null) {
    assertWholeRupees(input.monthlyFee, "monthly fee");

    if (input.monthlyFee < 0) {
      throw new FinanceServiceError(
        "A monthly fee cannot be negative.",
        "AMOUNT_OUT_OF_BOUNDS",
      );
    }
  }

  const filter: Record<string, unknown> = {
    hostelId: input.hostelId,
    isDeleted: false,
    status: { $in: ["ACTIVE", "PENDING"] },
  };

  if (input.residentIds) {
    filter._id = {
      $in: input.residentIds.filter((id) => Types.ObjectId.isValid(id)),
    };
  }

  const update: Record<string, unknown> = {
    monthlyFee: input.monthlyFee,
    updatedBy: principal.userId,
  };

  // An override without a stated reason is the thing nobody can explain a year
  // later, so one is recorded whenever a fee diverges from the schedule.
  if (input.monthlyFee !== null) {
    update.feeOverrideReason = input.reason ?? "set by hostel admin";
    update.feeOverrideSetAt = new Date();
  }

  const result = await ResidentModel.updateMany(filter, { $set: update });

  await auditFinanceAction(principal, {
    action: "RESIDENT_MONTHLY_FEE_SET",
    // The rate card figure, not a payment. Required by the envelope (§5.3), and
    // a fee change is exactly the kind of write that used to leave no amount.
    amountAfter: input.monthlyFee ?? 0,
    amountBefore: 0,
    entityId: new Types.ObjectId(String(input.hostelId)),
    entityType: "Resident",
    hostelId: input.hostelId,
    reason: input.reason ?? `applied to ${result.modifiedCount ?? 0} residents`,
    source: "RESIDENT_FEE_EDITOR",
  });

  return {
    monthlyFee: input.monthlyFee,
    updatedCount: result.modifiedCount ?? 0,
  };
}
