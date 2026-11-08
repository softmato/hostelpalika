import "server-only";

import { Types } from "mongoose";

import { subscriptionClaimReceivedEmail } from "@hostel/shared/email/templates/billing/subscription-claim-received";
import { subscriptionClaimRejectedEmail } from "@hostel/shared/email/templates/billing/subscription-claim-rejected";
import { sendEmail } from "@hostel/shared/email/sender";
import type { EmailContent } from "@hostel/shared/email/templates/layout";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import { SubscriptionPaymentModel } from "@hostel/db/models/SubscriptionPayment";

import { connectToDatabase } from "@/lib/db";
import { settlePayment } from "@/modules/billing/subscription-payment.service";
import {
  SubscriptionError,
  getSubscriptionState,
  invoiceIdFor,
  outstandingFor,
  type InvoiceRecord,
} from "@/modules/billing/subscription.service";
import { formatEmailDate } from "@/modules/hostels/hostel-registration.events";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";
import type { PlanPaymentInstructions, PlanPaymentClaim } from "@/lib/billing/billing.types";
export type { PlanPaymentInstructions, PlanPaymentClaim } from "@/lib/billing/billing.types";

/**
 * The manual lane: an owner pays us by QR and sends back the proof.
 *
 * ## Why a lane and not a replacement
 *
 * `subscription-payment.service` opens a Softmato checkout, and that is the
 * rail this platform is built on. This file is what runs when the rail is not
 * carrying owner-initiated payments — which is today — and it does **not**
 * retire when the rail lands. There will always be an owner whose banking app
 * worked and whose checkout did not, and a business that can only be paid one
 * way is a business that turns money away. So the two coexist: the pay screen
 * offers the rail first once there is one, and this underneath it.
 *
 * ## Nothing here records money
 *
 * A claim is a **statement by the payer**, and the whole design follows from
 * refusing to treat one as a settlement:
 *
 * - the row is written `IN_REVIEW`, and `outstandingFor` sums only `SETTLED`,
 *   so a claim moves no balance, publishes no hostel and clears no due;
 * - the only thing that turns it into money received is
 *   `reviewPlanPaymentClaim`, run by a platform admin who has looked at the
 *   proof, and that hands off to the same `settlePayment` a webhook uses — one
 *   receipt path, one activation path, one publish path;
 * - a refusal writes `FAILED` and leaves the invoice exactly as it was.
 *
 * This is the same shape as a resident's `PaymentEvent` claim one level down,
 * for the same reason, and the guards on the proof asset are lifted from it
 * deliberately rather than reinvented — every one of them was a security fix.
 *
 * ## One claim in flight at a time
 *
 * An owner who taps submit twice, or who pays and claims again the next day
 * because nobody has written back yet, must not produce two rows a reviewer has
 * to reconcile against one payment. The second attempt is refused with the fact
 * that the first is still being looked at, which is also the answer to the
 * question they were really asking.
 */

/** Same fortnight the resident claim path allows. See `claim.service.ts`. */
const EVIDENCE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Free text an owner attaches to a claim, and a reviewer's note back. */
const NOTE_MAX = 500;
const REFERENCE_MAX = 64;

type ProofAsset = {
  _id: Types.ObjectId;
  hostelId?: Types.ObjectId | null;
  kind?: string;
  ownerId?: Types.ObjectId | null;
  systemDocumentKind?: string | null;
  uploadCompletedAt?: Date | null;
};

/**
 * The proof, checked the way a resident's is.
 *
 * Ownership, tenancy, a completed upload, an upload made recently, and not one
 * of our own documents. A missing asset and somebody else's answer identically
 * — a caller probing ids must not learn which of them exist.
 */
async function loadProof(
  assetId: string,
  hostelId: string,
  actorId: string,
): Promise<ProofAsset> {
  const asset = Types.ObjectId.isValid(assetId)
    ? await FileAssetModel.findOne({
        _id: assetId,
        isDeleted: false,
        status: "ACTIVE",
      }).lean<ProofAsset | null>()
    : null;

  if (!asset || asset.ownerId?.toString() !== actorId) {
    throw new SubscriptionError(
      "That file is not yours to submit. Please attach the screenshot again.",
      "PROOF_NOT_OWNED",
      403,
    );
  }

  if (asset.hostelId && asset.hostelId.toString() !== hostelId) {
    throw new SubscriptionError(
      "That file is not yours to submit. Please attach the screenshot again.",
      "PROOF_NOT_OWNED",
      403,
    );
  }

  if (!asset.uploadCompletedAt) {
    throw new SubscriptionError(
      "That file did not finish uploading. Please attach the screenshot again.",
      "PROOF_UPLOAD_INCOMPLETE",
      422,
    );
  }

  if (asset.uploadCompletedAt.getTime() < Date.now() - EVIDENCE_MAX_AGE_MS) {
    throw new SubscriptionError(
      "That upload has expired. Please attach the screenshot again.",
      "PROOF_UPLOAD_INCOMPLETE",
      422,
    );
  }

  /*
   * Our own receipt is evidence that *we* were paid, which is the thing being
   * claimed — circular, and the most recent payment document an owner has to
   * hand. The resident path learnt this the hard way.
   */
  if (asset.systemDocumentKind) {
    throw new SubscriptionError(
      "That is a document we issued, not proof of a payment you made. Attach the screenshot from your banking app.",
      "PROOF_IS_OUR_DOCUMENT",
      422,
    );
  }

  return asset;
}

async function loadInvoiceById(invoiceId: string) {
  const invoice = await SubscriptionInvoiceModel.findById(
    invoiceId,
  ).lean<InvoiceRecord | null>();

  if (!invoice) {
    throw new SubscriptionError("Invoice not found.", "INVOICE_NOT_FOUND", 404);
  }

  return invoice;
}

/** Never throws: a claim that was accepted was accepted, mail or no mail. */
async function deliver(
  action: string,
  to: string | undefined,
  message: EmailContent,
) {
  if (!to) return;

  const result = await sendEmail({
    category: message.category,
    html: message.html,
    subject: message.subject,
    to,
  });

  if (!result.sent) {
    console.warn(
      JSON.stringify({
        action: `${action}_email_failed`,
        level: "warn",
        reason: result.reason,
        to,
      }),
    );
  }
}

/* ── What the owner's pay screen needs ─────────────────────────────────── */


/**
 * Everything the owner's "pay your plan" screen draws, in one read.
 *
 * The QR is the platform's own merchant image from the operations config —
 * `collectionQrUrl`, the same one a field agent shows an owner. It is one
 * picture for the whole platform rather than a per-invoice payload, because
 * there is no gateway session behind it: the owner scans, pays what the screen
 * says, and tells us they have.
 *
 * Answers with `qr: null` rather than failing when nothing is configured. The
 * screen still has to render — the amount, the invoice number and the proof
 * form are all still true — and an owner who can reach us another way must not
 * be blocked by an unset setting.
 */
export async function getPlanPaymentInstructions(
  hostelId: string,
): Promise<PlanPaymentInstructions> {
  await connectToDatabase();

  const state = await getSubscriptionState(hostelId);
  const operations = await getOperationsConfig();

  const qr = operations.collectionQrUrl
    ? {
        label: operations.collectionQrLabel || "Scan to pay",
        url: operations.collectionQrUrl,
      }
    : null;

  if (!state?.invoice) {
    return {
      amountDue: 0,
      claim: null,
      dueBy: state?.subscription.dueBy ?? null,
      invoice: null,
      overdue: false,
      qr,
      reference: null,
    };
  }

  const pending = await SubscriptionPaymentModel.findOne({
    invoiceId: new Types.ObjectId(state.invoice.id),
    status: "IN_REVIEW",
  })
    .sort({ claimedAt: -1 })
    .lean<{
      amount: number;
      claimedAt?: Date | null;
      gatewayReference?: string | null;
    } | null>();

  return {
    amountDue: state.outstanding,
    claim: pending
      ? {
          amount: pending.amount,
          claimedAt: pending.claimedAt?.toISOString() ?? null,
          reference: pending.gatewayReference ?? null,
        }
      : null,
    dueBy: state.subscription.dueBy,
    invoice: {
      id: state.invoice.id,
      invoiceNumber: state.invoice.invoiceNumber,
      planName: state.invoice.planName,
    },
    overdue: state.subscription.dueBy
      ? Date.parse(state.subscription.dueBy) < Date.now()
      : false,
    qr,
    reference: state.invoice.invoiceNumber,
  };
}

/* ── Submitting a claim ────────────────────────────────────────────────── */

/**
 * "I have paid, here is the screenshot."
 *
 * Writes one `IN_REVIEW` row against the hostel's open invoice and emails the
 * owner to say it arrived and that nothing switches off while we look. The
 * amount is **the server's**, not the client's: a claim is for whatever is
 * outstanding on the invoice, so there is nowhere for a caller to put a figure
 * of their own — the same reason `openSubscriptionCheckout` takes no amount.
 */
export async function submitPlanPaymentClaim(
  hostelId: string,
  input: { note?: string; proofAssetId: string; reference?: string },
  actorId: string,
) {
  await connectToDatabase();

  const invoiceId = await invoiceIdFor(hostelId);
  const invoice = await loadInvoiceById(invoiceId);
  const { outstanding } = await outstandingFor(invoice);

  if (outstanding <= 0) {
    throw new SubscriptionError(
      "This invoice is already settled in full.",
      "ALREADY_SETTLED",
      409,
    );
  }

  const existing = await SubscriptionPaymentModel.findOne({
    invoiceId: invoice._id,
    status: "IN_REVIEW",
  }).lean<{ _id: Types.ObjectId } | null>();

  if (existing) {
    throw new SubscriptionError(
      "You have already sent us proof for this invoice and our team is checking it. We will email you as soon as it is verified.",
      "CLAIM_ALREADY_IN_REVIEW",
      409,
    );
  }

  const proof = await loadProof(input.proofAssetId, hostelId, actorId);

  const payment = await SubscriptionPaymentModel.create({
    amount: outstanding,
    claimNote: input.note?.trim().slice(0, NOTE_MAX) || null,
    claimedAt: new Date(),
    gatewayReference: input.reference?.trim().slice(0, REFERENCE_MAX) || null,
    hostelId: invoice.hostelId,
    invoiceId: invoice._id,
    method: "MANUAL",
    proofAssetId: proof._id,
    recordedBy: actorId,
    status: "IN_REVIEW",
    subscriptionId: invoice.subscriptionId,
  }).catch((error: unknown) => {
    // PLAN-1: a claim sent at the same moment as this one won the unique index.
    if ((error as { code?: number })?.code === 11000) {
      throw new SubscriptionError(
        "You have already sent us proof for this invoice and our team is checking it. We will email you as soon as it is verified.",
        "CLAIM_ALREADY_IN_REVIEW",
        409,
      );
    }
    throw error;
  });

  await AuditLogModel.create({
    action: "SUBSCRIPTION_PAYMENT_CLAIM_SUBMITTED",
    actorId,
    actorType: "USER",
    entityId: String(payment._id),
    entityType: "SubscriptionPayment",
    hostelId: invoice.hostelId,
    metadata: {
      amount: outstanding,
      invoiceNumber: invoice.invoiceNumber,
      proofAssetId: String(proof._id),
    },
  });

  const subscription = await HostelSubscriptionModel.findById(
    invoice.subscriptionId,
  ).lean<{ currentPeriodEnd?: Date | null; dueBy?: Date | null } | null>();

  /*
   * "Your plan works until…" is the due while one is open, and the period's
   * end otherwise. The due comes first because a team hostel's period is
   * already running while it owes — its end is a month out, and quoting that
   * to an owner with a balance due in three days would read as more time than
   * they have. Neither date is invented here; a missing one drops the sentence.
   */
  await deliver(
    "subscription_claim_received",
    invoice.billedTo?.email,
    subscriptionClaimReceivedEmail({
      amount: outstanding,
      hostelName: invoice.billedTo?.hostelName || "your hostel",
      invoiceNumber: invoice.invoiceNumber,
      ownerName: invoice.billedTo?.name,
      planName: invoice.planName,
      reference: input.reference?.trim() || null,
      worksUntil: formatEmailDate(
        subscription?.dueBy ?? subscription?.currentPeriodEnd ?? null,
      ),
    }),
  );

  return {
    amount: outstanding,
    claimedAt: new Date().toISOString(),
    id: String(payment._id),
    invoiceNumber: invoice.invoiceNumber,
  };
}

/* ── The platform's review queue ───────────────────────────────────────── */


/**
 * Every claim waiting on a person, oldest first.
 *
 * Oldest first on purpose, and it is the one ordering decision on this list:
 * the queue is a promise to answer within a couple of days, and a newest-first
 * feed is how the one claim nobody got to becomes the one claim nobody ever
 * gets to.
 */
export async function listPlanPaymentClaims(): Promise<PlanPaymentClaim[]> {
  await connectToDatabase();

  const claims = await SubscriptionPaymentModel.find({ status: "IN_REVIEW" })
    .sort({ claimedAt: 1 })
    .limit(200)
    .lean<
      Array<{
        _id: Types.ObjectId;
        amount: number;
        claimNote?: string | null;
        claimedAt?: Date | null;
        gatewayReference?: string | null;
        hostelId: Types.ObjectId;
        invoiceId: Types.ObjectId;
        proofAssetId?: Types.ObjectId | null;
      }>
    >();

  if (claims.length === 0) return [];

  const invoices = await SubscriptionInvoiceModel.find({
    _id: { $in: claims.map((claim) => claim.invoiceId) },
  }).lean<InvoiceRecord[]>();

  const invoiceById = new Map(invoices.map((row) => [String(row._id), row]));

  return claims.map((claim) => {
    const invoice = invoiceById.get(String(claim.invoiceId));

    return {
      amount: claim.amount,
      claimedAt: claim.claimedAt?.toISOString() ?? null,
      hostelId: claim.hostelId.toString(),
      hostelName:
        invoice?.billedTo?.hostelName || invoice?.billedTo?.name || "—",
      id: String(claim._id),
      invoiceNumber: invoice?.invoiceNumber ?? "—",
      note: claim.claimNote ?? null,
      planName: invoice?.planName ?? "—",
      proofAssetId: claim.proofAssetId ? String(claim.proofAssetId) : null,
      reference: claim.gatewayReference ?? null,
    };
  });
}

/* ── Reviewing one ─────────────────────────────────────────────────────── */

/**
 * A platform admin's answer to one claim.
 *
 * **Approve** hands straight to `settlePayment`, which is the same function the
 * gateway webhook calls: the receipt is issued, the invoice recomputed, the
 * subscription activated if nothing is left owed, and the hostel published if
 * its rules now allow it. The owner's due tag disappears because the balance
 * actually moved, not because a flag was flipped — that is the whole reason
 * approval goes through the shared path rather than writing `SETTLED` here.
 * The receipt email is `onPaymentSettled`'s, already sent from in there, so the
 * approval half of "we will email you either way" needs nothing of its own.
 *
 * **Refuse** writes `FAILED` with the reviewer's own words and touches nothing
 * else. The invoice never had the money taken off it, so there is nothing to
 * put back.
 *
 * Both stamp `reviewedBy`. It is deliberately not `recordedBy`, which on a
 * manual row is the owner who made the claim — an audit of this lane asks who
 * *let it through*, and conflating the two would leave that unanswerable.
 */
export async function reviewPlanPaymentClaim(
  paymentId: string,
  input: { approve: boolean; note?: string },
  actorId: string,
) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(paymentId)) {
    throw new SubscriptionError("Payment not found.", "PAYMENT_NOT_FOUND", 404);
  }

  const claim = await SubscriptionPaymentModel.findById(paymentId).lean<{
    _id: Types.ObjectId;
    amount: number;
    hostelId: Types.ObjectId;
    invoiceId: Types.ObjectId;
    status: string;
  } | null>();

  if (!claim) {
    throw new SubscriptionError("Payment not found.", "PAYMENT_NOT_FOUND", 404);
  }

  if (claim.status !== "IN_REVIEW") {
    throw new SubscriptionError(
      "This claim has already been reviewed.",
      "CLAIM_ALREADY_REVIEWED",
      409,
    );
  }

  const note = input.note?.trim().slice(0, NOTE_MAX) || null;
  const invoice = await loadInvoiceById(claim.invoiceId.toString());

  if (input.approve) {
    /*
     * Stamped **before** settling, not after. `settlePayment` claims the row
     * with a conditional update on its status, and a write that landed after it
     * would race the receipt issue and the activation for the same document.
     * The reviewer is a fact about the decision, and the decision is made here.
     */
    await SubscriptionPaymentModel.updateOne(
      { _id: claim._id },
      {
        $set: { reviewNote: note, reviewedAt: new Date(), reviewedBy: actorId },
      },
    );

    const state = await settlePayment(String(claim._id), {
      actorId,
      expectedHostelId: claim.hostelId.toString(),
    });

    await AuditLogModel.create({
      action: "SUBSCRIPTION_PAYMENT_CLAIM_APPROVED",
      actorId,
      actorType: "USER",
      entityId: String(claim._id),
      entityType: "SubscriptionPayment",
      hostelId: claim.hostelId,
      metadata: {
        amount: claim.amount,
        invoiceNumber: invoice.invoiceNumber,
        note,
      },
    });

    return state;
  }

  const refused = await SubscriptionPaymentModel.updateOne(
    { _id: claim._id, status: "IN_REVIEW" },
    {
      $set: {
        failureReason: note ?? "Could not be matched to a payment we received.",
        reviewNote: note,
        reviewedAt: new Date(),
        reviewedBy: actorId,
        status: "FAILED",
      },
    },
  );

  // Approved by someone else a moment earlier: no "we could not find it" email (P7-26).
  if (refused.modifiedCount === 0) {
    throw new SubscriptionError(
      "This claim has already been reviewed.",
      "CLAIM_ALREADY_REVIEWED",
      409,
    );
  }

  await AuditLogModel.create({
    action: "SUBSCRIPTION_PAYMENT_CLAIM_REJECTED",
    actorId,
    actorType: "USER",
    entityId: String(claim._id),
    entityType: "SubscriptionPayment",
    hostelId: claim.hostelId,
    metadata: {
      amount: claim.amount,
      invoiceNumber: invoice.invoiceNumber,
      note,
    },
  });

  const { outstanding } = await outstandingFor(invoice);

  await deliver(
    "subscription_claim_rejected",
    invoice.billedTo?.email,
    subscriptionClaimRejectedEmail({
      amount: claim.amount,
      hostelName: invoice.billedTo?.hostelName || "your hostel",
      invoiceNumber: invoice.invoiceNumber,
      outstanding,
      ownerName: invoice.billedTo?.name,
      planName: invoice.planName,
      reason: note,
    }),
  );

  return getSubscriptionState(claim.hostelId.toString());
}
