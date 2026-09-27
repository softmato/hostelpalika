import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { applyCreditToInvoice } from "@/modules/finance/credit-balance.service";
import { formatBsPeriod, hostelPeriodOf } from "@/lib/hostel-day";
import {
  computeInvoiceAmount,
  getEffectiveSchedule,
  listedRoomRates,
  periodBounds,
  resolveMonthlyCharge,
} from "@/modules/finance/fee-schedule.service";
import type {
  BillableResident,
  FeeScheduleRecord,
  ListedRoomRates,
} from "@/modules/finance/fee-schedule.service";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { getRentConcession } from "@/modules/finance/rent-concession.service";
import { paidBeforeJoining } from "@/modules/finance/paid-till";
import { sumAmounts } from "@/modules/finance/money";
import { allocateReferenceCode } from "@/modules/finance/reference-sequence.service";
import { applyPendingFeeOffsQuietly } from "@/modules/offer-program/offer-program.service";
import { HostelModel } from "@hostel/db/models/Hostel";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { OfferAwardModel } from "@hostel/db/models/OfferAward";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";
import { ResidentModel } from "@hostel/db/models/Resident";

/**
 * The one way an obligation comes into existence (target §6.1).
 *
 * Replaces all three current billing paths (current §5.1). They disagreed about
 * everything that matters: A1 prorated a mid-month move-in and A2 did not, A1
 * billed `PENDING` residents and A2 did not, A1 forced an end-of-month due date
 * and A2 took one from the request body, and A3 let an admin type an amount
 * directly. Which of them a resident got was a race on **which screen an admin
 * opened first** — so two residents of the same hostel, on the same rate, could
 * owe different amounts for the same month.
 *
 * ## Reads never bill
 *
 * The dominant path was a lazy insert inside `getMonthlyPaymentMatrix` — a `GET`
 * that created financial records as a side effect of rendering a screen. That is
 * deleted here. Billing happens when someone (or the monthly cron) asks for it,
 * and nowhere else.
 *
 * ## Nothing is guessed and nothing is silently zero
 *
 * Every resident this run cannot price is **returned** — as a skip with a reason
 * or a failure with an error code — and the caller is expected to show them. The
 * old `resident.monthlyFee || defaultAmount || 0` chain billed a misconfigured
 * resident nothing and nobody found out until somebody asked in November (P8).
 *
 * ## Ordering
 *
 * Resolve every charge first, write second. A missing fee schedule aborts the
 * run **before any invoice exists**, because half a billing month is far harder
 * to reason about than none of it — and the fix for a missing schedule is data,
 * not a softer resolver (§7.3).
 */

export type BillingSkipReason =
  | "ALREADY_BILLED"
  | "ALREADY_MOVED_OUT"
  | "NOT_YET_RESIDENT"
  | "NO_BILLABLE_DAYS"
  /** Already paid to the hostel before it joined us — see `Resident.paidTill`. */
  | "PAID_BEFORE_JOINING"
  | "ZERO_CHARGE";

export type BillingSkip = {
  detail?: string;
  reason: BillingSkipReason;
  residentId: string;
};

export type BillingFailure = {
  errorCode: string;
  message: string;
  residentId: string;
};

export type BilledInvoice = {
  /** What the resident actually owes — after credit, not before it. */
  amount: number;
  /** Credit consumed by this invoice (target §9.4). Zero for most. */
  creditApplied: number;
  invoiceId: string;
  referenceCode: string;
  residentId: string;
};

export type BillingCycleResult = {
  billed: BilledInvoice[];
  failures: BillingFailure[];
  period: string;
  skipped: BillingSkip[];
  totalBilled: number;
};

export type BillingCycleInput = {
  /** Defaults to the last day of the period — the rule the dominant path used. */
  dueDate?: Date;
  hostelId: Types.ObjectId | string;
  /** "YYYY-MM". */
  period: string;
  /** Restricts the run to specific residents. Absent means the whole hostel. */
  residentIds?: (Types.ObjectId | string)[];
};

type BillableResidentRow = BillableResident & {
  hostelId: Types.ObjectId;
  paidTill?: string | null;
  status?: string;
};

/**
 * Who gets billed for a period.
 *
 * `ACTIVE` residents, plus anyone who moved out **during or after** the period
 * started — a resident who left on the 8th still owes eight days, which the
 * current system never charged them for because it only looked at who is here
 * today.
 *
 * `PENDING` residents are **not** billed, resolving one of A1/A2's
 * disagreements in A2's favour. A pending resident has not been admitted; an
 * invoice for them is a bill for a room they may never take, and it lands in
 * their dunning queue.
 */
export async function findBillableResidents(
  hostelId: Types.ObjectId | string,
  period: string,
  residentIds?: (Types.ObjectId | string)[],
): Promise<BillableResidentRow[]> {
  const { start } = periodBounds(period);

  const filter: Record<string, unknown> = {
    hostelId,
    isDeleted: { $ne: true },
    // A short-stay guest paid their nights upfront through the booking.
    stayEndsAt: null,
    $or: [
      { status: "ACTIVE" },
      { moveOutDate: { $gte: start }, status: "MOVED_OUT" },
    ],
  };

  if (residentIds?.length) {
    filter._id = { $in: residentIds };
  }

  return ResidentModel.find(filter).lean<BillableResidentRow[]>();
}

type BillingPlan = {
  amount: number;
  bedType: string | null;
  basis: string;
  /** "Dashain · 50% off", or null at full rent. Goes on the invoice line. */
  concessionNote: string | null;
  feeScheduleId: Types.ObjectId | null;
  prorationBasis: string | null;
  resident: BillableResidentRow;
};

/**
 * Prices every resident without writing anything.
 *
 * Separated from the write pass so the whole run can be abandoned on a
 * hostel-wide problem. A per-resident problem is collected and reported; a
 * missing schedule is not survivable and is re-thrown by the caller.
 */
export function planBillingCycle(
  residents: BillableResidentRow[],
  schedule: FeeScheduleRecord | null,
  period: string,
  listed: ListedRoomRates = new Map(),
  /**
   * The month's festival discount, if the hostel set one (see
   * `rent-concession.service`). Passed in rather than read here so the whole
   * pass stays synchronous and testable, and so it is read once per run.
   */
  concession: { percentOff: number; reason: string | null } = {
    percentOff: 0,
    reason: null,
  },
): { failures: BillingFailure[]; plans: BillingPlan[]; skipped: BillingSkip[] } {
  const failures: BillingFailure[] = [];
  const plans: BillingPlan[] = [];
  const skipped: BillingSkip[] = [];

  for (const resident of residents) {
    const residentId = resident._id.toString();

    // Checked before pricing: a month already settled at the counter before the
    // hostel joined is not owed, whatever the rate card says about it.
    if (paidBeforeJoining(resident.paidTill, period)) {
      skipped.push({ reason: "PAID_BEFORE_JOINING", residentId });
      continue;
    }

    try {
      const charge = resolveMonthlyCharge(
        resident,
        schedule,
        listed,
        concession.percentOff,
      );
      const invoiceAmount = computeInvoiceAmount(
        charge.amount,
        resident.moveInDate,
        resident.moveOutDate,
        period,
      );

      if (invoiceAmount.amount <= 0) {
        // Reported, never billed as a zero invoice. A resident who owes nothing
        // this month owes it for a reason, and the reason is the useful output.
        skipped.push({
          detail: invoiceAmount.prorationBasis ?? undefined,
          reason: skipReasonFor(invoiceAmount.prorationBasis, charge.amount),
          residentId,
        });
        continue;
      }

      plans.push({
        amount: invoiceAmount.amount,
        basis: charge.basis,
        bedType: charge.bedType,
        concessionNote: concessionNote(charge.concessionPercent, concession.reason),
        feeScheduleId: charge.feeScheduleId,
        prorationBasis: invoiceAmount.prorationBasis,
        resident,
      });
    } catch (error) {
      if (!(error instanceof FinanceServiceError)) {
        throw error;
      }

      failures.push({
        errorCode: error.errorCode,
        message: error.message,
        residentId,
      });
    }
  }

  return { failures, plans, skipped };
}

/**
 * What the discount is called on the resident's own bill.
 *
 * Snapshotted onto the line like every other figure here, so the row can be
 * deleted afterwards and a bill from Dashain still explains itself. The reason
 * leads when the hostel gave one, because "Dashain" answers the question and
 * "50% off" only restates the arithmetic the amount already shows.
 */
function concessionNote(percentOff: number, reason: string | null) {
  if (percentOff <= 0) {
    return null;
  }

  return reason ? `${reason} · ${percentOff}% off` : `${percentOff}% off`;
}

function skipReasonFor(
  prorationBasis: string | null,
  monthlyCharge: number,
): BillingSkipReason {
  if (prorationBasis === "not yet resident") {
    return "NOT_YET_RESIDENT";
  }

  if (prorationBasis === "already moved out") {
    return "ALREADY_MOVED_OUT";
  }

  if (prorationBasis === "no billable days") {
    return "NO_BILLABLE_DAYS";
  }

  // A deliberate zero rate — the staff member's child of `resolveMonthlyCharge`.
  return monthlyCharge === 0 ? "ZERO_CHARGE" : "NO_BILLABLE_DAYS";
}

/** Mongo's duplicate-key error — here, the double-billing index firing. */
function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: number })?.code === 11000;
}

/**
 * Issues one month's invoices.
 *
 * Re-running is a no-op: the unique index on
 * `(hostelId, residentId, period, kind)` over the occupying statuses is what
 * makes that true, not the pre-read below. The pre-read only exists so the
 * common case reports `ALREADY_BILLED` without generating a reference code it
 * would then throw away — two concurrent runs still collide on the index, and
 * the loser records a skip.
 */
export async function runBillingCycle(
  input: BillingCycleInput,
  principal?: ApiPrincipal,
): Promise<BillingCycleResult> {
  await connectToDatabase();

  /*
   * The due date is the month's closing **day**, not its closing instant.
   *
   * `end` is 23:59:59.999 UTC and Nepal is 5h45m ahead of that, so stamping it
   * onto an invoice dated a BS month produced a due date every BS reader in the
   * product correctly named as the *first of the next month* — a Bhadra invoice
   * saying it was due in Aswin, on every invoice, in the direction that reads as
   * a deadline already missed.
   */
  const { lastDay } = periodBounds(input.period);
  const dueDate = input.dueDate ?? lastDay;

  const hostel = await HostelModel.findOne({ _id: input.hostelId })
    .select("referencePrefix roomConfigurations")
    .lean<{
      referencePrefix?: string;
      roomConfigurations?: { monthlyRent?: number; roomType: string }[];
    } | null>();

  if (!hostel) {
    throw new FinanceServiceError("Hostel was not found.", "HOSTEL_SCOPE_REQUIRED");
  }

  const [residents, schedule, concession] = await Promise.all([
    findBillableResidents(input.hostelId, input.period, input.residentIds),
    getEffectiveSchedule(input.hostelId, input.period),
    getRentConcession(input.hostelId, input.period),
  ]);

  const listed = listedRoomRates(hostel.roomConfigurations);

  const { failures, plans, skipped } = planBillingCycle(
    residents,
    schedule,
    input.period,
    listed,
    concession,
  );

  /*
   * A missing schedule aborts the run unless the hostel prices its rooms some
   * other way.
   *
   * The rule is unchanged where it was right: "a missing schedule is hostel-wide,
   * not per resident: every resident without an override hits it, and billing
   * only the overridden ones would leave the month half-done in a way nobody
   * could distinguish from a finished run." A per-resident override is still not
   * allowed to rescue a hostel with no rate card, for exactly that reason.
   *
   * A **listed room rate** is different in kind. It is not one resident's
   * exception; it is a price the owner set for a room type, so a hostel priced
   * that way has a complete answer for its whole roster and billing it leaves no
   * half-month behind. Room types the owner never costed still fail per resident,
   * the way `BED_TYPE_NOT_PRICED` already does.
   *
   * So the test is the hostel's price source, not the plan count: no schedule
   * and no listed rents means nothing could price anybody, and a hostel-wide
   * error is the fact an owner can act on.
   */
  const scheduleMissing = failures.find(
    (failure) => failure.errorCode === "FEE_SCHEDULE_MISSING",
  );

  if (scheduleMissing && listed.size === 0) {
    throw new FinanceServiceError(
      `No fee schedule covers ${formatBsPeriod(input.period) || input.period}, and no room type has a listed rent. No invoices were issued.`,
      "FEE_SCHEDULE_MISSING",
    );
  }

  const alreadyBilled = new Set(
    (
      await InvoiceModel.find({
        hostelId: input.hostelId,
        kind: "MONTHLY_RENT",
        period: input.period,
        residentId: { $in: plans.map((plan) => plan.resident._id) },
        status: { $ne: "VOID" },
      }).lean<{ residentId: Types.ObjectId }[]>()
    ).map((invoice) => invoice.residentId.toString()),
  );

  const billed: BilledInvoice[] = [];

  for (const plan of plans) {
    const residentId = plan.resident._id.toString();

    if (alreadyBilled.has(residentId)) {
      skipped.push({ reason: "ALREADY_BILLED", residentId });
      continue;
    }

    const referenceCode = await allocateReferenceCode(
      input.hostelId,
      hostel.referencePrefix,
    );

    try {
      const invoice = (await InvoiceModel.create({
        createdBy: principal?.userId,
        dueDate,
        hostelId: input.hostelId,
        kind: "MONTHLY_RENT",
        lines: [
          {
            amount: plan.amount,
            basis: plan.basis,
            bedType: plan.bedType,
            /*
             * Named, not keyed. `2083-05` is the storage form and it is not what
             * a resident reads on their own bill; the description is snapshotted
             * at issue time precisely so it stays legible without a lookup.
             */
            description: plan.concessionNote
              ? `Monthly rent — ${formatBsPeriod(input.period) || input.period} · ${plan.concessionNote}`
              : `Monthly rent — ${formatBsPeriod(input.period) || input.period}`,
            feeScheduleId: plan.feeScheduleId,
            prorationBasis: plan.prorationBasis ?? undefined,
          },
        ],
        period: input.period,
        referenceCode,
        residentId: plan.resident._id,
        status: "OPEN",
        totalAmount: plan.amount,
      })) as unknown as { _id: Types.ObjectId };

      // Target §9.4: available credit comes off the new invoice as a negative
      // line. Consumed **before** the invoice is discounted, on purpose — a
      // crash between the two leaves credit spent with the invoice it names
      // recorded on the entry, which is recoverable and which 5.1's drift job
      // reports. The other order would hand out a discount nothing paid for.
      const creditApplied = await applyCreditToInvoice({
        hostelId: input.hostelId,
        invoiceId: invoice._id,
        maxAmount: plan.amount,
        residentId: plan.resident._id,
      });

      if (creditApplied > 0) {
        await InvoiceModel.updateOne(
          { _id: invoice._id },
          {
            $push: {
              lines: {
                amount: -creditApplied,
                basis: "CREDIT",
                description: "Credit from earlier overpayment",
              },
            },
            $set: { totalAmount: plan.amount - creditApplied },
          },
        );
      }

      billed.push({
        amount: plan.amount - creditApplied,
        creditApplied,
        invoiceId: invoice._id.toString(),
        referenceCode,
        residentId,
      });
    } catch (error) {
      if (!isDuplicateKey(error)) {
        throw error;
      }

      // The double-billing control fired: a concurrent run got there first.
      // A skip, not a failure — the resident is billed exactly once, which is
      // what was wanted.
      skipped.push({ reason: "ALREADY_BILLED", residentId });
    }
  }

  // Resident Offer Program: a fee-off award waiting for a bill comes off this
  // one, paid by HostelPalika. One query for the whole run, then only the few
  // residents who have one.
  if (billed.length > 0) {
    const waiting = await OfferAwardModel.distinct("residentId", {
      kind: "FEE_OFF",
      residentId: { $in: billed.map((invoice) => invoice.residentId) },
      status: "AWARDED",
    });

    for (const residentId of waiting) {
      await applyPendingFeeOffsQuietly(residentId);
    }
  }

  const totalBilled = sumAmounts(
    billed.map((invoice) => invoice.amount),
    "invoice amount",
  );

  // No principal means the monthly cron ran this, and `AuditLog.actorId` is
  // required — inventing an actor would attribute a scheduled run to a real
  // person who did not perform it, which is worse than the gap. A scheduled
  // run's record is a `ReconciliationRun` (§5.4), which arrives in Block 5;
  // until then the cron response is the record. Every *invoice* it issues is
  // still individually attributable through `createdBy` and its own events.
  if (principal) {
    await auditFinanceAction(principal, {
      action: "BILLING_CYCLE_RUN",
      amountAfter: totalBilled,
      amountBefore: 0,
      entityId: new Types.ObjectId(String(input.hostelId)),
      entityType: "Hostel",
      hostelId: input.hostelId,
      reason: `${billed.length} issued, ${skipped.length} skipped, ${failures.length} failed`,
      source: "BILLING_CYCLE",
    });
  }

  return {
    billed,
    failures,
    period: input.period,
    skipped,
    totalBilled,
  };
}

/**
 * Cancels an invoice that should never have been issued (target §9.2).
 *
 * The other half of removing the unrestricted PATCH: an admin who billed the
 * wrong resident, or billed a month twice, previously fixed it by typing over
 * the record. Voiding is the honest version — the invoice keeps its amount and
 * its history and stops being an obligation, and the double-billing index
 * excludes VOID precisely so the period can be re-billed correctly afterwards.
 *
 * **An invoice with settled money cannot be voided.** Cancelling an obligation
 * that has been paid would orphan the payment: the money is real, it is still in
 * the hostel's account, and voiding would remove the only record of what it was
 * for. Reverse the payments first — that path exists, notifies the resident, and
 * leaves the reversal on the ledger, which is exactly what should happen before
 * an invoice disappears.
 */
export async function voidInvoice(
  invoiceId: Types.ObjectId | string,
  options: { hostelIds?: string[]; principal: ApiPrincipal; reason: string },
): Promise<{ invoiceId: string; status: string }> {
  await connectToDatabase();

  if (!options.reason || options.reason.trim().length < 3) {
    throw new FinanceServiceError(
      "Voiding an invoice needs a reason.",
      "AMOUNT_OUT_OF_BOUNDS",
    );
  }

  const filter: Record<string, unknown> = { _id: invoiceId };

  if (options.hostelIds) {
    filter.hostelId = { $in: options.hostelIds };
  }

  const invoice = await InvoiceModel.findOne(filter).lean<{
    _id: Types.ObjectId;
    hostelId: Types.ObjectId;
    status: string;
    totalAmount: number;
  } | null>();

  if (!invoice) {
    throw new FinanceServiceError("Invoice was not found.", "FEE_SCHEDULE_MISSING");
  }

  if (invoice.status === "VOID") {
    return { invoiceId: invoice._id.toString(), status: "VOID" };
  }

  const settled = await PaymentEventModel.countDocuments({
    invoiceId: invoice._id,
    status: "SETTLED",
  });

  if (settled > 0) {
    throw new FinanceServiceError(
      "This invoice has settled payments. Reverse them before voiding it.",
      "INVOICE_HAS_SETTLED_PAYMENTS",
    );
  }

  await InvoiceModel.updateOne(
    { _id: invoice._id },
    {
      $set: {
        status: "VOID",
        updatedBy: options.principal.userId,
        voidReason: options.reason,
        voidedAt: new Date(),
        voidedBy: options.principal.userId,
      },
    },
  );

  await auditFinanceAction(options.principal, {
    action: "INVOICE_VOIDED",
    amountAfter: 0,
    amountBefore: invoice.totalAmount,
    entityId: invoice._id,
    entityType: "Invoice",
    hostelId: invoice.hostelId,
    invoiceId: invoice._id.toString(),
    reason: options.reason,
    source: "INVOICE_VOID",
  });

  return { invoiceId: invoice._id.toString(), status: "VOID" };
}

export type BillingPeriodSummary = {
  invoiceCount: number;
  notBilledResidentIds: string[];
  period: string;
  totalBilled: number;
};

/**
 * What a period's billing looks like right now, without changing it.
 *
 * The screen this serves used to be the billing path — opening it created the
 * invoices it then displayed. Here it only answers, and `notBilledResidentIds`
 * is the useful half: a billable resident with no invoice is either a run that
 * has not happened or one that could not price them, and both are things the
 * owner needs to see rather than have quietly fixed on page load.
 */
export async function getBillingPeriodSummary(
  hostelId: Types.ObjectId | string,
  period: string,
): Promise<BillingPeriodSummary> {
  await connectToDatabase();

  const [invoices, residents] = await Promise.all([
    InvoiceModel.find({
      hostelId,
      kind: "MONTHLY_RENT",
      period,
      status: { $ne: "VOID" },
    }).lean<{ residentId: Types.ObjectId; totalAmount: number }[]>(),
    findBillableResidents(hostelId, period),
  ]);

  const billed = new Set(invoices.map((invoice) => invoice.residentId.toString()));

  return {
    invoiceCount: invoices.length,
    notBilledResidentIds: residents
      .map((resident) => resident._id.toString())
      .filter((residentId) => !billed.has(residentId)),
    period,
    totalBilled: sumAmounts(
      invoices.map((invoice) => invoice.totalAmount),
      "invoice amount",
    ),
  };
}

export type HostelBillingOutcome = {
  billedCount: number;
  errorCode?: string;
  errorMessage?: string;
  failureCount: number;
  hostelId: string;
  hostelName?: string;
  skippedCount: number;
  totalBilled: number;
};

/**
 * The Bikram Sambat month containing `now` — `2083-05` for Bhadra 2083.
 *
 * What the cron wakes up and bills. It used to slice the Gregorian year and
 * month out of a UTC instant, which was wrong twice over: Nepal is 5h45m ahead,
 * so a run fired in the last quarter of a UTC day billed the month the hostel had
 * already left; and the month itself was Gregorian, so "this month's rent" meant
 * a span no hostel's books recognise.
 *
 * Delegated rather than reimplemented. There is one answer to "which month is
 * this" in this product and it lives in `lib/hostel-day.ts`.
 */
export function periodOf(now: Date): string {
  return hostelPeriodOf(now);
}

/**
 * The monthly run, across every hostel.
 *
 * **One hostel's failure must not stop the others.** Three hostels on the dev
 * data configure exactly one room type, the string `"Shared"`, which does not
 * say how many people share — §7.3 is explicit that a bed type is reported
 * rather than guessed, so no rate card can price them. They now bill anyway,
 * from the rent the owner listed against that room type
 * (`resolveMonthlyCharge`), because a stated price is not a guess. A hostel that
 * listed no rent either still fails, that is still the correct outcome, and the
 * fix is still their data rather than a softer resolver. Aborting the platform's
 * billing because of one of them would be absurd, so each hostel is isolated and
 * its error is returned as a row.
 *
 * The caller — the cron route — returns these rows verbatim. The current
 * dunning job's stats "go nowhere, so a silently failing cron is invisible"
 * (current §5.6), and repeating that here would hide exactly the hostels that
 * need attention.
 */
export async function runBillingCycleForAllHostels(
  period: string,
): Promise<HostelBillingOutcome[]> {
  await connectToDatabase();

  const hostels = await HostelModel.find({ isDeleted: { $ne: true } })
    .select("name")
    .lean<{ _id: Types.ObjectId; name?: string }[]>();

  const outcomes: HostelBillingOutcome[] = [];

  for (const hostel of hostels) {
    try {
      const result = await runBillingCycle({ hostelId: hostel._id, period });

      outcomes.push({
        billedCount: result.billed.length,
        failureCount: result.failures.length,
        hostelId: hostel._id.toString(),
        hostelName: hostel.name,
        skippedCount: result.skipped.length,
        totalBilled: result.totalBilled,
      });
    } catch (error) {
      outcomes.push({
        billedCount: 0,
        errorCode:
          error instanceof FinanceServiceError ? error.errorCode : "BILLING_RUN_FAILED",
        errorMessage: (error as Error).message,
        failureCount: 0,
        hostelId: hostel._id.toString(),
        hostelName: hostel.name,
        skippedCount: 0,
        totalBilled: 0,
      });
    }
  }

  return outcomes;
}
