import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { formatBsPeriod } from "@/lib/hostel-day";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { setConcessionCredit } from "@/modules/finance/credit-balance.service";
import { discountRent } from "@/modules/finance/fee-schedule.service";
import { recomputeInvoiceBalance } from "@/modules/finance/payment-event.service";
import {
  type ConcessionChange,
  notifyRentConcession,
} from "@/modules/finance/rent-concession-notify";
import { InvoiceBalanceModel } from "@hostel/db/models/InvoiceBalance";

const RENT_BASES = new Set(["SCHEDULE", "OVERRIDE", "MANUAL"]);
import { InvoiceModel } from "@hostel/db/models/Invoice";

/**
 * Applying a festival discount to a month that has **already been billed**.
 *
 * ## The case this exists for
 *
 * `cron/billing-cycle` issues a month's invoices on its first day, and a hostel
 * rarely decides Dashain in Aswin. A discount set on Kartik 5 therefore arrives
 * after forty residents already hold a bill for the full rent — and without this,
 * the warden would set 50%, see the row appear, and nothing whatever would happen
 * to the people it was meant for. That is worse than refusing the save.
 *
 * ## The bill is corrected, never rewritten
 *
 * The rent line is left exactly as issued and a **negative line** is added under
 * it:
 *
 * ```
 * Monthly rent — Kartik 2083            8,000
 * Dashain · 50% off                    -4,000
 *                             Total:    4,000
 * ```
 *
 * Editing the 8,000 down to 4,000 would make the invoice lie about what the rent
 * for Kartik was, and would silently contradict a bill the resident may already
 * have screenshotted or paid against. Two lines keep both truths: the rent was
 * 8,000, and 4,000 of it was forgiven. It is the same shape an applied credit
 * already takes, and `concessionPercent` on the line is what makes this one
 * findable so a change from 50% to 40% moves it instead of stacking a second.
 *
 * ## Money already paid becomes credit, because it cannot be un-taken
 *
 * `recomputeInvoiceBalance` re-derives the status from the settled events against
 * the new total, so a resident who had paid 5,000 of the 8,000 now shows PAID with
 * 1,000 over. That excess is written as credit against their next month rather
 * than left as an invisible negative — a refund is a decision for a human, and
 * credit is the part the system can do by itself.
 *
 * ## Nothing is reissued, because nothing was ever a file
 *
 * A resident's invoice has no stored document — the invoice screens read the
 * `Invoice` row, so the corrected total is what they see the moment this runs.
 * There is no PDF to regenerate and no old copy to chase.
 *
 * **Receipts are not touched, and must not be.** A receipt asserts that the
 * hostel *received* a specific amount on a specific day, and a discount does not
 * change what was received — the 5,000 that arrived on Kartik 3 arrived. Voiding
 * or reissuing it would make the hostel's own record of money it holds disagree
 * with its bank statement, which is the one thing `Receipt`'s immutability
 * exists to prevent. Where the payment now exceeds the bill, the difference
 * appears as credit; the receipt for it stays exactly as issued.
 *
 * What *is* sent is a notification, because the resident is holding a bill that
 * no longer matches ours — see `rent-concession-notify`.
 *
 * ## Withdrawing a discount only unwinds bills nobody has paid
 *
 * Deleting the row restores the total on invoices with **no settled payment**. An
 * invoice with money against it keeps the discount, because raising a bill a
 * resident has already part-paid against — after being told they owed less — is
 * the one correction the hostel cannot make politely, and because the credit it
 * generated may already have been spent on the following month.
 */

/** Only rent is discounted. Admission and deposit are not a monthly fee. */
const RENT_KIND = "MONTHLY_RENT";

type InvoiceLine = {
  amount: number;
  basis: string;
  concessionPercent?: number;
  description: string;
};

export type ConcessionBackfill = {
  /** Rupees taken off across every invoice touched. */
  discounted: number;
  /** Invoices whose totals were reduced or restored. */
  invoicesChanged: number;
  /** Invoices left alone because money is already settled against them. */
  invoicesKept: number;
  /** Rupees handed back as credit, because they were already paid. */
  refundedAsCredit: number;
};

const EMPTY: ConcessionBackfill = {
  discounted: 0,
  invoicesChanged: 0,
  invoicesKept: 0,
  refundedAsCredit: 0,
};

/**
 * What has actually been paid against an invoice, from the balance cache.
 *
 * A read, unlike `recomputeInvoiceBalance`, which rebuilds and stores it. The
 * cache is written by every settlement path, so it is current here; and if it
 * were stale the only consequence on this branch is an invoice left at its
 * discount, which is the conservative answer anyway.
 */
async function settledAmountOf(invoiceId: Types.ObjectId) {
  const balance = await InvoiceBalanceModel.findOne({ invoiceId })
    .select("settledAmount")
    .lean<{ settledAmount?: number } | null>();

  return balance?.settledAmount ?? 0;
}

/**
 * Rewrites the discount line on every issued invoice for one month.
 *
 * `percentOff: 0` withdraws it. Returns what it did, so the screen can say "38
 * bills reduced" rather than leaving an owner to check the Money tab and guess.
 *
 * Safe to re-run: the line is keyed by `concessionPercent` and replaced, the
 * credit entry is keyed by the invoice and replaced, and the total is recomputed
 * from the lines each time. Running it twice with the same percentage is a no-op.
 */
export async function applyConcessionToIssuedInvoices(input: {
  hostelId: Types.ObjectId | string;
  percentOff: number;
  period: string;
  principal?: ApiPrincipal;
  reason: string | null;
}): Promise<ConcessionBackfill> {
  await connectToDatabase();

  /*
   * Not `.lean()`. The pre-validate hook on `Invoice` refuses a `totalAmount`
   * that does not equal the sum of its lines, and that check is the thing keeping
   * the denormalisation honest — so this goes through `save()` on a real document
   * rather than an `updateOne` that would skip it.
   */
  const invoices = await InvoiceModel.find({
    hostelId: input.hostelId,
    kind: RENT_KIND,
    period: input.period,
    status: { $ne: "VOID" },
  });

  if (invoices.length === 0) {
    return EMPTY;
  }

  const monthName = formatBsPeriod(input.period) || input.period;
  const note = input.reason
    ? `${input.reason} · ${input.percentOff}% off`
    : `${input.percentOff}% off`;

  const result = { ...EMPTY };
  /*
   * Gathered, then sent once at the end — not inside the loop.
   *
   * A notification per iteration would interleave writes to the notification
   * collection with writes to the ledger, so a failure halfway through would
   * leave some residents told about a correction and the rest of the month
   * uncorrected. The money is finished before anybody is told about it.
   */
  const changes: ConcessionChange[] = [];

  for (const invoice of invoices) {
    const document = invoice as unknown as {
      _id: Types.ObjectId;
      hostelId: Types.ObjectId;
      lines: InvoiceLine[];
      residentId: Types.ObjectId;
      save: () => Promise<unknown>;
      totalAmount: number;
    };

    const before = document.totalAmount;
    const existing = document.lines.find((line) => line.concessionPercent);

    /*
     * The rent this discount is a percentage *of*: the charged lines only.
     *
     * Credit lines are excluded because credit is money the resident already had,
     * not rent — discounting it would pay them a percentage of their own balance.
     * The existing discount line is excluded because the base has to be the same
     * number whether this is the first pass or the third.
     */
    const base = document.lines
      // FIN-9: rent only, never a khata or fine line.
      .filter((line) => RENT_BASES.has(line.basis) && !line.concessionPercent)
      .reduce((sum, line) => sum + line.amount, 0);

    /*
     * Clamped so the invoice cannot go negative. An invoice that had credit
     * applied at issue time is already below its rent, and a 100% discount on the
     * rent would otherwise leave the hostel owing the resident money on a bill.
     */
    const creditApplied = document.lines
      .filter((line) => line.basis === "CREDIT" && !line.concessionPercent)
      .reduce((sum, line) => sum + line.amount, 0);
    const discount = Math.min(
      base - discountRent(base, input.percentOff),
      Math.max(base + creditApplied, 0),
    );

    /*
     * Withdrawing a discount from a bill that has money against it: leave it.
     * See the header — this is the one correction a hostel cannot make politely.
     *
     * The settled figure is only needed on this branch, so it is read here rather
     * than for every invoice: `recomputeInvoiceBalance` *writes* the cache, and
     * calling it on the way in as well as after the save would double the writes
     * this loop makes to say nothing new.
     */
    if (input.percentOff === 0 && existing) {
      const settled = await settledAmountOf(document._id);

      if (settled > 0) {
        result.invoicesKept += 1;
        continue;
      }
    }

    const lines = document.lines.filter((line) => !line.concessionPercent);

    if (discount > 0) {
      lines.push({
        amount: -discount,
        basis: "CREDIT",
        concessionPercent: input.percentOff,
        /*
         * The words, not the key. `2083-06` is storage; this line is read on a
         * resident's own bill beside the rent it reduces, and it is snapshotted
         * here so it stays legible after the discount row is deleted.
         */
        description: `${note} — ${monthName}`,
      });
    }

    const after = lines.reduce((sum, line) => sum + line.amount, 0);

    if (after === before) {
      continue;
    }

    document.lines = lines;
    document.totalAmount = after;
    await document.save();

    result.discounted += Math.max(before - after, 0);
    result.invoicesChanged += 1;

    /*
     * Status first, then the excess. `recomputeInvoiceBalance` reads the total off
     * the document, so it has to run *after* the save or it would derive PAID or
     * PARTIAL from the figure this call just replaced.
     */
    const balance = await recomputeInvoiceBalance(document._id);
    const excess = Math.max(balance.settledAmount - after, 0);

    await setConcessionCredit({
      amount: excess,
      hostelId: document.hostelId,
      invoiceId: document._id,
      note: `${note} — ${monthName}, already paid`,
      residentId: document.residentId,
    });

    result.refundedAsCredit += excess;
    changes.push({
      after,
      before,
      credited: excess,
      residentId: document.residentId,
    });

    /*
     * Audited per invoice, not once per run. The chained finance log is keyed on
     * amounts before and after, and "38 bills reduced by 4,000 each" is not an
     * auditable fact about any one of them — the resident who asks why their
     * Kartik bill changed has to be answerable on their own invoice.
     *
     * Skipped when the cron or a script drives this, matching `runBillingCycle`:
     * the entry records *who* decided, and there is nobody to name.
     */
    if (input.principal) {
      await auditFinanceAction(input.principal, {
        action:
          input.percentOff === 0
            ? "RENT_CONCESSION_REMOVED"
            : "RENT_CONCESSION_APPLIED",
        amountAfter: after,
        amountBefore: before,
        entityId: document._id,
        entityType: "Invoice",
        hostelId: document.hostelId,
        invoiceId: document._id.toString(),
        reason: input.percentOff === 0 ? `Full rent restored for ${monthName}` : note,
        source: "RENT_CONCESSION",
      });
    }
  }

  /*
   * Only when something moved. A discount set before the month's run reaches this
   * function with no invoices to correct, and there is nothing to tell a resident
   * whose bill has not been issued yet — theirs will arrive with the discount
   * already on it. This is the same silence `notifyRateCardChanged` keeps for a
   * hostel's first rate card.
   */
  await notifyRentConcession({
    changes,
    hostelId: input.hostelId,
    monthName,
    note: input.percentOff === 0 ? null : note,
  });

  return result;
}
