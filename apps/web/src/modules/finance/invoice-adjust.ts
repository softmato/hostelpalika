import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { setConcessionCredit } from "@/modules/finance/credit-balance.service";
import { recomputeInvoiceBalance } from "@/modules/finance/payment-event.service";
import { InvoiceModel } from "@hostel/db/models/Invoice";

export type AdjustKind = "LEAVE" | "MOVE_OUT" | "WRITE_OFF";

type Line = { adjust?: AdjustKind; amount: number; basis: string; description: string };

/**
 * Puts one taking-off line of `kind` on an issued bill, replacing any earlier
 * one of the same kind — so calling it again with a new figure is a correction,
 * and `takeOff: 0` removes the line.
 *
 * The rent concession's rules, shared: a line rather than an edit (the bill
 * keeps saying what it was and why it changed), never below zero, and money
 * already paid above the new total becomes the resident's credit instead of
 * vanishing.
 */
export async function setAdjustment(input: {
  description: string;
  invoiceId: Types.ObjectId | string;
  kind: AdjustKind;
  principal?: ApiPrincipal;
  /** Rupees to take off, positive. Clamped to what the bill holds. */
  takeOff: number;
}): Promise<{ after: number; before: number; taken: number } | null> {
  await connectToDatabase();

  const invoice = await InvoiceModel.findById(input.invoiceId);

  if (!invoice || invoice.status === "VOID") {
    return null;
  }

  const doc = invoice as unknown as {
    _id: Types.ObjectId;
    hostelId: Types.ObjectId;
    lines: Line[];
    residentId: Types.ObjectId;
    save: () => Promise<unknown>;
    totalAmount: number;
  };

  const before = doc.totalAmount;
  const lines = doc.lines.filter((line) => line.adjust !== input.kind);
  const rest = lines.reduce((sum, line) => sum + line.amount, 0);
  const taken = Math.max(0, Math.min(Math.round(input.takeOff), rest));

  if (taken > 0) {
    lines.push({ adjust: input.kind, amount: -taken, basis: "CREDIT", description: input.description });
  }

  const after = rest - taken;

  if (after === before) {
    return { after, before, taken };
  }

  doc.lines = lines;
  doc.totalAmount = after;
  await doc.save();

  const balance = await recomputeInvoiceBalance(doc._id);

  await setConcessionCredit({
    amount: Math.max(balance.settledAmount - after, 0),
    hostelId: doc.hostelId,
    invoiceId: doc._id,
    kind: input.kind.toLowerCase(),
    note: `${input.description}, already paid`,
    residentId: doc.residentId,
  });

  if (input.principal) {
    await auditFinanceAction(input.principal, {
      action: "INVOICE_ADJUSTED",
      amountAfter: after,
      amountBefore: before,
      entityId: doc._id,
      entityType: "Invoice",
      hostelId: doc.hostelId,
      invoiceId: doc._id.toString(),
      reason: input.description,
      source: input.kind,
    });
  }

  return { after, before, taken };
}
