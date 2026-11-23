import type { Types } from "mongoose";

import { formatBsPeriod } from "@/lib/hostel-day";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";

/** `FileAsset.contentHash`'s shape: hex sha256. */
export const CONTENT_HASH_RE = /^[a-f0-9]{64}$/;

/**
 * Refuses receipt bytes a payment at this hostel already carries, and says which
 * payment. Asked at presign, before a byte moves: the second send of one receipt
 * sat at "Uploading… 100%" and then read as a dropped connection, with nothing
 * telling the resident it had been used (ch 35). Only the sender's own payment
 * is described. Go: `finance.EvidenceUsed`.
 */
export async function assertEvidenceUnused(
  hostelId: Types.ObjectId | string,
  hash: string,
  residentId: Types.ObjectId | string | null,
): Promise<void> {
  const prior = await PaymentEventModel.findOne({ evidenceHash: hash, hostelId })
    .select("amount invoiceId occurredAt residentId")
    .lean<{
      amount: number;
      invoiceId?: Types.ObjectId | null;
      occurredAt?: Date | null;
      residentId?: Types.ObjectId | null;
    }>();

  if (!prior) return;

  if (!residentId || !prior.residentId || prior.residentId.toString() !== residentId.toString()) {
    throw new FinanceServiceError(
      "This receipt was already sent for another payment at this hostel. Upload the receipt for this payment.",
      "EVIDENCE_ALREADY_USED",
    );
  }

  const invoice = prior.invoiceId
    ? await InvoiceModel.findById(prior.invoiceId).select("period").lean<{ period?: string | null }>()
    : null;
  const month = invoice?.period ? formatBsPeriod(invoice.period) : "";

  throw new FinanceServiceError(
    `You already sent this receipt for Rs ${prior.amount.toLocaleString("en-US")}${
      month ? ` for ${month}` : ""
    }. Upload the receipt for this payment.`,
    "EVIDENCE_ALREADY_USED",
    {
      priorPeriod: invoice?.period ?? null,
      priorSubmittedAt: prior.occurredAt?.toISOString() ?? null,
    },
  );
}
