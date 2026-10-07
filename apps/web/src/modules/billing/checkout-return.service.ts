import "server-only";

import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { softmatoDocumentNumbers } from "@/modules/billing/balance-document";
import { fetchInvoiceDetail } from "@/modules/billing/billing-gateway";
import { isLifetimePeriodEnd } from "@/modules/billing/lifetime";
import { resolveOwnedHostel } from "@/modules/billing/subscription-access";
import { reconcileInvoiceFromSoftmato } from "@/modules/billing/subscription-reconcile.service";
import { assertAgentFiledHostel } from "@/modules/team/team.service";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";

/**
 * What actually happened, asked of Softmato, for the page the owner lands on
 * coming back from checkout.
 *
 * ## Nothing here reads the URL
 *
 * The owner arrives at the return page by *clicking*, and they can arrive
 * there without having paid — a bookmark, a back button, a forwarded link, or
 * simply pressing cancel at the wallet. So the query string carries one thing,
 * our own invoice number, and it is treated as a *navigation* hint: which
 * purchase are you asking about. It is checked against rows this reader owns
 * before it is used, and the answer to "did they pay" comes from a server-side
 * call, never from a parameter. **Softmato puts no payment status in that URL,
 * and anything that looks like one did not come from them.**
 *
 * ## Why the invoice, not the transaction
 *
 * The obvious read is `getTransaction`, and it is the right one when you have
 * a transaction id. Here we do not: the id arrives on the webhook, and the
 * webhook may not have landed yet — the owner's browser is usually faster than
 * a server-to-server POST. `getInvoice` is addressed by something we have
 * known since we raised it, and its `paid_minor` is the same ledger the
 * transaction would be reported from.
 *
 * ## It provisions, and that is allowed
 *
 * §6.4 names two authoritative answers: a verified webhook, **or** a
 * server-side read this app made. This is the second. It matters because a
 * webhook needs a hostname Softmato's server can reach, and a laptop does not
 * have one — without this, a developer's payment would land, be visible in
 * Softmato's ledger, and never turn anything on.
 *
 * The two paths do not race. Both settle through
 * `reconcileInvoiceFromSoftmato`, which writes the difference between what
 * Softmato says was paid and what we have already recorded, so whichever runs
 * second finds nothing owing.
 */

export type ReturnState =
  | {
      /** `null` while the activation is still landing — the page says so. */
      activeUntil: string | null;
      kind: "paid";
      invoiceNumber: string;
      planName: string;
      total: number;
    }
  | {
      kind: "partial";
      balance: number;
      invoiceNumber: string;
      planName: string;
    }
  | { kind: "unpaid"; invoiceNumber: string; planName: string; total: number }
  | { kind: "void"; invoiceNumber: string }
  /** Raised locally, no document yet — or Softmato was unreachable just now. */
  | { kind: "pending_document"; invoiceNumber: string }
  | { kind: "unknown" };

/** The stages the return page shows, announced as each one starts. */
export type ReturnStep = "confirm" | "record" | "activate";

export async function readReturnState(
  viewer: { role: string; userId: string },
  invoiceNumber: string,
  step: (name: ReturnStep) => void = () => {},
): Promise<ReturnState> {
  await connectToDatabase();

  const invoice = await SubscriptionInvoiceModel.findOne({
    invoiceNumber,
  }).lean<{
    _id: Types.ObjectId;
    hostelId: Types.ObjectId;
    planName: string;
    softmatoBalanceInvoices?: { no: string }[];
    softmatoInvoiceNo?: string | null;
  } | null>();

  if (!invoice) return { kind: "unknown" };

  /*
   * Ownership, checked through the same widening the rest of the billing flow
   * uses — a public registration can resolve an owner to a different `User`
   * row than the one that was signed in when the form was typed, and a
   * narrower check here would refuse an owner their own receipt.
   *
   * A refusal is reported as `unknown`, exactly as a number that does not
   * exist. A reader probing invoice numbers learns nothing from the
   * difference.
   */
  try {
    await resolveOwnedHostel(invoice.hostelId.toString(), viewer.userId).catch(() =>
      // The agent who filed the hostel collects online from their own phone,
      // so they are the one who lands here.
      assertAgentFiledHostel(viewer, invoice.hostelId.toString()),
    );
  } catch {
    return { kind: "unknown" };
  }

  /*
   * The newest document is the one just checked out: a balance document when
   * part was paid where Softmato never saw it, the original otherwise. The
   * original stays open on their side once a balance document settles it.
   */
  const documentNo = softmatoDocumentNumbers(invoice).at(-1);

  if (!documentNo) {
    return { invoiceNumber, kind: "pending_document" };
  }

  step("confirm");
  const detail = await fetchInvoiceDetail(documentNo).catch(() => null);

  if (!detail) return { invoiceNumber, kind: "pending_document" };

  const paid = detail.status === "paid";

  if (paid) step("record");

  /*
   * Provision on what the read just said, before rendering it.
   *
   * Failure here does not fail the page. The reader still gets a truthful
   * answer about their money — that is what they came for — and the next
   * check, or a webhook, will settle it. Showing an error because a write
   * downstream of the answer went wrong would tell somebody who has paid that
   * something is broken with their payment.
   */
  await reconcileInvoiceFromSoftmato(invoice._id).catch((error) => {
    console.error(
      JSON.stringify({
        action: "return_reconcile_failed",
        invoiceNumber,
        level: "error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  });

  if (detail.status === "void" || detail.status === "written_off") {
    return { invoiceNumber, kind: "void" };
  }

  if (paid) {
    step("activate");

    // Read back, not assumed: the reconcile above may have lost a race it is
    // allowed to lose, and this is what the owner will see on their dashboard.
    const subscription = await HostelSubscriptionModel.findOne({ hostelId: invoice.hostelId })
      .select("currentPeriodEnd status")
      .lean<{ currentPeriodEnd?: Date | null; status?: string } | null>();

    return {
      // A lifetime plan has no "until" worth printing.
      activeUntil:
        subscription?.status === "ACTIVE" &&
        subscription.currentPeriodEnd &&
        !isLifetimePeriodEnd(subscription.currentPeriodEnd)
          ? subscription.currentPeriodEnd.toISOString()
          : null,
      invoiceNumber,
      kind: "paid",
      planName: invoice.planName,
      total: Math.round(detail.total_minor / 100),
    };
  }

  if (detail.status === "partially_paid") {
    return {
      balance: Math.round(detail.due_minor / 100),
      invoiceNumber,
      kind: "partial",
      planName: invoice.planName,
    };
  }

  /*
   * `unpaid` and `past_due` land here together. Both mean the invoice is still
   * open and still payable, which is the same thing to say to the reader: the
   * payment did not complete, and trying again is the normal path rather than
   * an error state.
   */
  return {
    invoiceNumber,
    kind: "unpaid",
    planName: invoice.planName,
    total: Math.round(detail.total_minor / 100),
  };
}
