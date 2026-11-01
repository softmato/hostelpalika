import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { extractReferenceCodes } from "@/modules/finance/reference-code";
import { notifyClaimReviewed } from "@/modules/finance/finance-notify";
import { settleEvent } from "@/modules/finance/payment-event.service";
import { markReferralConverted } from "@/modules/referrals/referral.service";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { InvoiceBalanceModel } from "@hostel/db/models/InvoiceBalance";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";
import { ResidentModel } from "@hostel/db/models/Resident";

/**
 * The owner's review queue (target §11.4, plan item 2.8).
 *
 * Replaces `approvePaymentProof` / `rejectPaymentProof`. The behaviours those
 * earned the hard way are preserved and, where possible, are now structural
 * rather than remembered:
 *
 * - **Double approval is refused.** It used to be a `findOneAndUpdate` filtered
 *   on `status: "PENDING"` on the proof, followed by a five-attempt
 *   compare-and-set retry loop against the mutable `paidAmount`. `settleEvent`
 *   keeps the first half — the same PENDING-pinned filter — and deletes the
 *   second: there is no mutable balance to race, because the balance is a sum.
 * - **A part payment settles the month partially.** Unchanged in effect, but it
 *   now falls out of the arithmetic instead of a `Math.min` clamp.
 * - **The resident is told even when payment email is switched off** (item 0.6).
 */

export type ReviewQueueRow = {
  amount: number;
  confirmation: string;
  eventId: string;
  evidenceAssetId: string | null;
  /**
   * The evidence's MIME type, so the reviewer renders it with something that can
   * actually display it. A bank's PDF receipt in an `<img>` is a broken-image
   * icon, and a reviewer looking at one has no evidence at all — but the claim
   * still shows "Screenshot attached" in green.
   */
  evidenceMimeType: string | null;
  invoiceId: string | null;
  method: string;
  occurredAt: Date;
  period: string | null;
  referenceNote: string | null;
  /**
   * Why a `REJECTED` claim was turned down. Null on every other status.
   *
   * The resident's own screen reads this queue row, and without the reason a
   * rejection is invisible to them: their card kept saying "your hostel is
   * checking it" forever, so the one person who has to act on the decision was
   * the only one not told about it.
   */
  rejectionReason: string | null;
  residentId: string;
  residentName: string;
  /**
   * Every check, green or not (item 3.5). Computed on the server so the badge a
   * reviewer sees and the gate `Approve all` applies are the same rule — two
   * implementations of "looks fine" is how a bulk sweep approves a row the
   * screen had marked amber.
   */
  checks: ClaimCheck[];
  /** True when every check passed. The only rows `Approve all` may touch. */
  allGreen: boolean;
  /**
   * Notes computed at submission, e.g. `SIMILAR_EVIDENCE` (item 3.4) or
   * `EVIDENCE_NOT_MACHINE_CHECKED` (gap fix 3). **Never a rejection** — a flag
   * only ever moves a decision in front of a human, by turning a check amber and
   * so keeping the row out of `Approve all`.
   */
  reviewFlags: string[];
  status: string;
  transactionCode: string | null;
};

/**
 * One thing a reviewer would otherwise have to check by eye (target §11.4).
 *
 * `ok: false` is never a rejection and never blocks a single-row approval — the
 * owner may still approve a claim with an amber check, because they can see the
 * screenshot and we cannot. It only excludes the row from `Approve all`.
 */
export type ClaimCheck = {
  detail: string;
  key:
    | "EVIDENCE"
    | "AMOUNT"
    /**
     * Whether the file is what it claims to be, as opposed to what it says.
     *
     * Its own key rather than more `EVIDENCE` detail, because the two answer
     * different questions and a reviewer acts on them differently. `EVIDENCE`
     * amber means *open the image and read it* — the numbers may be fine. `FILE`
     * amber means *the image may not be what it looks like*, and reading it
     * harder will not settle that; the thing to do is ask the resident for the
     * original, or check the account.
     */
    | "FILE"
    | "INVOICE_OPEN"
    | "PAYEE"
    | "REFERENCE"
    | "SIMILARITY";
  ok: boolean;
};

type QueueEventRow = {
  _id: Types.ObjectId;
  amount: number;
  confirmation: string;
  evidenceAssetId?: Types.ObjectId | null;
  invoiceId?: Types.ObjectId | null;
  occurredAt: Date;
  provider?: string;
  rawPayload?: { referenceNote?: string | null; transactionCode?: string | null };
  rejectionReason?: string | null;
  residentId?: Types.ObjectId | null;
  reviewFlags?: string[];
  status: string;
};

/** Ledger provider → the word the review screen has always shown. */
const METHOD_BY_PROVIDER: Record<string, string> = {
  BANK: "BANK_TRANSFER",
  CASH: "CASH",
  ESEWA: "ESEWA",
  FONEPAY: "FONEPAY",
  KHALTI: "KHALTI",
  NONE: "OTHER",
};

/**
 * Claims awaiting a decision, newest first.
 *
 * Deliberately only `RESIDENT_CLAIM` events: gateway and statement money settles
 * itself and has never needed a human, and putting it here would bury the items
 * that do need one (target P7).
 */
export async function listReviewQueue(
  hostelId: Types.ObjectId | string,
  status: string = "PENDING",
): Promise<ReviewQueueRow[]> {
  await connectToDatabase();

  const events = await PaymentEventModel.find({
    hostelId,
    source: "RESIDENT_CLAIM",
    status,
  })
    .sort({ occurredAt: -1 })
    .limit(200)
    .lean<QueueEventRow[]>();

  if (events.length === 0) {
    return [];
  }

  const [residents, invoices, assets] = await Promise.all([
    // Deleted residents are included on purpose: their pending claims are
    // still counted by the reports, so hiding them left a count with no rows.
    ResidentModel.find({
      _id: { $in: events.map((event) => event.residentId).filter(Boolean) },
    })
      .select("firstName lastName")
      .lean<{ _id: Types.ObjectId; firstName?: string; lastName?: string }[]>(),
    InvoiceModel.find({
      _id: { $in: events.map((event) => event.invoiceId).filter(Boolean) },
    })
      .select("period referenceCode status totalAmount")
      .lean<InvoiceForCheck[]>(),
    FileAssetModel.find({
      _id: { $in: events.map((event) => event.evidenceAssetId).filter(Boolean) },
    })
      .select("mimeType")
      .lean<{ _id: Types.ObjectId; mimeType?: string }[]>(),
  ]);

  const mimeByAsset = new Map(
    assets.map((asset) => [asset._id.toString(), asset.mimeType ?? null]),
  );

  const balances = await InvoiceBalanceModel.find({
    invoiceId: { $in: invoices.map((invoice) => invoice._id) },
  })
    .select("invoiceId settledAmount")
    .lean<{ invoiceId: Types.ObjectId; settledAmount?: number }[]>();

  const invoiceById = new Map(
    invoices.map((invoice) => [invoice._id.toString(), invoice]),
  );
  const settledByInvoice = new Map(
    balances.map((balance) => [
      balance.invoiceId.toString(),
      balance.settledAmount ?? 0,
    ]),
  );

  const nameById = new Map(
    residents.map((resident) => [
      resident._id.toString(),
      `${resident.firstName ?? ""} ${resident.lastName ?? ""}`.trim(),
    ]),
  );
  const periodById = new Map(
    invoices.map((invoice) => [invoice._id.toString(), invoice.period ?? null]),
  );

  return events
    .map((event) => {
    const invoice = event.invoiceId
      ? (invoiceById.get(event.invoiceId.toString()) ?? null)
      : null;
    const checks = claimChecks(event, invoice, {
      settled: event.invoiceId
        ? (settledByInvoice.get(event.invoiceId.toString()) ?? 0)
        : 0,
    });

    return {
    allGreen: checks.every((check) => check.ok),
    amount: event.amount,
    checks,
    confirmation: event.confirmation,
    eventId: event._id.toString(),
    evidenceAssetId: event.evidenceAssetId?.toString() ?? null,
    evidenceMimeType: event.evidenceAssetId
      ? (mimeByAsset.get(event.evidenceAssetId.toString()) ?? null)
      : null,
    invoiceId: event.invoiceId?.toString() ?? null,
    method: METHOD_BY_PROVIDER[event.provider ?? "NONE"] ?? "OTHER",
    occurredAt: event.occurredAt,
    period: event.invoiceId ? (periodById.get(event.invoiceId.toString()) ?? null) : null,
    referenceNote: event.rawPayload?.referenceNote ?? null,
    rejectionReason: event.rejectionReason ?? null,
    residentId: event.residentId?.toString() ?? "",
    residentName: event.residentId
      ? (nameById.get(event.residentId.toString()) ?? "Removed resident")
      : "",
    reviewFlags: event.reviewFlags ?? [],
    status: event.status,
    transactionCode: event.rawPayload?.transactionCode ?? null,
    };
  });
}

type InvoiceForCheck = {
  _id: Types.ObjectId;
  period?: string;
  referenceCode?: string;
  status: string;
  totalAmount: number;
};

/**
 * Did the resident actually quote this invoice's reference code?
 *
 * **This check used to answer a different question than it appeared to.** It was
 * `ok: Boolean(invoice.referenceCode)` — whether the *invoice* carries a code,
 * which the billing run guarantees for every invoice it issues. So it was green
 * on essentially every row, and its label, `Reference EDU-0002-P`, read to an
 * owner as "the resident supplied EDU-0002-P" when nothing the resident typed
 * had been looked at. A check that is always green is not a check; it is
 * decoration that makes `Approve all` sweep rows nobody verified.
 *
 * It now reads what the resident actually submitted — the transaction id field
 * and the free-text note — through the same `extractReferenceCodes` the
 * statement matcher uses, so a code only counts if its check character verifies.
 *
 * The distinct amber for *a different invoice's code* is the valuable one: it is
 * a resident paying August's rent while quoting July's reference, which is the
 * single most common way money lands against the wrong month.
 */
function referenceCheck(
  event: {
    rawPayload?: { referenceNote?: string | null; transactionCode?: string | null };
  },
  invoice: InvoiceForCheck | null,
): ClaimCheck {
  const expected = invoice?.referenceCode;

  if (!expected) {
    return {
      detail: "Invoice has no reference code to quote",
      key: "REFERENCE",
      ok: false,
    };
  }

  const quoted = [
    ...extractReferenceCodes(event.rawPayload?.transactionCode),
    ...extractReferenceCodes(event.rawPayload?.referenceNote),
  ];

  if (quoted.includes(expected)) {
    return { detail: `Resident quoted ${expected}`, key: "REFERENCE", ok: true };
  }

  if (quoted.length > 0) {
    return {
      detail: `Quoted ${quoted[0]}, but this invoice is ${expected}`,
      key: "REFERENCE",
      ok: false,
    };
  }

  return {
    detail: `Did not quote ${expected}`,
    key: "REFERENCE",
    ok: false,
  };
}

/**
 * What the evidence itself says (gap fix 3).
 *
 * Reads the flags `evidence-ocr` left at submission rather than the image, so
 * this stays synchronous and every row in the queue is judged by the same rule
 * that `Approve all` applies.
 *
 * The green case is narrow on purpose: the amount *and* one of the two codes have
 * to have been found on the image. Anything else — a miss, a photo with no text,
 * a PDF, a recogniser that could not run — is amber, which costs a reviewer one
 * click and saves the case this check exists for.
 */
function evidenceCheck(event: {
  evidenceAssetId?: Types.ObjectId | null;
  reviewFlags?: string[];
}): ClaimCheck {
  if (!event.evidenceAssetId) {
    return { detail: "No screenshot attached", key: "EVIDENCE", ok: false };
  }

  const flags = event.reviewFlags ?? [];

  // Asked before the numbers, because it is the more fundamental question. A
  // receipt whose direction we could not read may be a record of the resident
  // being *paid*, and on such a file the numbers agreeing means nothing at all —
  // reporting "the amount and ID match this claim" in green would be true and
  // deeply misleading.
  if (
    flags.includes("EVIDENCE_IS_STATEMENT") ||
    flags.includes("EVIDENCE_DIRECTION_UNVERIFIED") ||
    flags.includes("EVIDENCE_OUTCOME_PENDING")
  ) {
    return directionCheck(event);
  }

  // Asked before the confirmation, because it outranks it. An id that is not
  // the shape this provider issues is worth a human's eye even when the same id
  // is legible on the screenshot — the two agreeing only means the resident
  // copied what the image said, and the image may be somebody else's receipt or
  // a different provider's entirely.
  if (flags.includes("EVIDENCE_TXN_ID_MALFORMED")) {
    return {
      detail: "The transaction ID is not the shape this provider issues — open it",
      key: "EVIDENCE",
      ok: false,
    };
  }

  if (flags.includes("EVIDENCE_TEXT_MATCHES_CLAIM")) {
    return {
      // The two are worth distinguishing. Since the claim form fills the amount
      // and the id *from* the screenshot, the weaker line can mean only that the
      // image agrees with itself — while this invoice's reference code comes from
      // our own database, so finding it on the image is a fact no amount of
      // copying off the receipt could produce.
      detail: flags.includes("EVIDENCE_REFERENCE_ON_IMAGE")
        ? "The screenshot carries this invoice's reference code and the amount"
        : flags.includes("EVIDENCE_TXN_ID_SHAPE_OK")
          ? "The amount and ID match, and the ID is the shape this provider issues"
          : "The amount and ID on the screenshot match this claim",
      key: "EVIDENCE",
      ok: true,
    };
  }

  if (flags.includes("EVIDENCE_NOT_A_PAYMENT_RECORD")) {
    return {
      // The resident was told this on the form and submitted anyway, which is
      // their right — an unusual receipt scores no signals either. It is the
      // reviewer's call now, and it is the first thing they should know.
      detail: "This does not look like a payment receipt at all — open it",
      key: "EVIDENCE",
      ok: false,
    };
  }

  if (flags.includes("EVIDENCE_NO_TEXT_FOUND")) {
    return {
      detail: "Nothing on this image matches the claim — open it",
      key: "EVIDENCE",
      ok: false,
    };
  }

  const missing = [
    flags.includes("EVIDENCE_AMOUNT_NOT_ON_IMAGE") ? "amount" : null,
    flags.includes("EVIDENCE_ID_NOT_ON_IMAGE") ? "transaction ID" : null,
  ].filter(Boolean);

  if (missing.length > 0) {
    return {
      detail: `Could not find the ${missing.join(" or the ")} on the screenshot — open it`,
      key: "EVIDENCE",
      ok: false,
    };
  }

  if (flags.includes("EVIDENCE_NOT_MACHINE_CHECKED")) {
    return {
      detail: "Attached, but nothing could read it — open it before approving",
      key: "EVIDENCE",
      ok: false,
    };
  }

  // No evidence flags at all: OCR is switched off for this deployment, so the
  // check falls back to what it can still assert — the file is a decoded,
  // non-blank image, because a blank one never became a claim (gap fix 3).
  return { detail: "Screenshot attached and readable", key: "EVIDENCE", ok: true };
}

/**
 * Did the money reach an account this hostel actually collects in?
 *
 * **The only check here that a payer cannot satisfy by typing.** Every other one
 * reads something the resident supplied: the amount they entered, the code they
 * quoted, the ID they copied. All of those are satisfiable in full by a resident
 * who sent the exact rent to a friend's wallet with the right code in the
 * remarks — the payment is real, the receipt is real, and the hostel receives
 * nothing. This reads the payee line and compares it against the accounts on the
 * hostel's own payment profile.
 *
 * A receipt naming somebody else never reaches this queue; it is refused on the
 * form. What arrives here is the gap between *verified as ours* and *could not
 * tell* — an unlabelled receipt, an unconfigured profile, an image nothing could
 * read — and only the first may be green.
 */
function payeeCheck(event: { reviewFlags?: string[] }): ClaimCheck {
  const flags = event.reviewFlags ?? [];

  // Reported even on a verified payee, because the two are independent facts: the
  // money reached the right account *and* the receipt is from a different app
  // than the resident said. Usually a mis-tap on a six-button row, occasionally
  // the sign that this receipt belongs to a different payment altogether.
  if (flags.includes("EVIDENCE_METHOD_MISMATCH")) {
    return {
      detail: flags.includes("EVIDENCE_PAYEE_VERIFIED")
        ? "Right account, but the receipt is from a different app than the resident chose"
        : "The receipt is from a different app than the resident chose — open it",
      key: "PAYEE",
      ok: false,
    };
  }

  if (flags.includes("EVIDENCE_PAYEE_VERIFIED")) {
    return {
      detail: "Paid into an account registered to this hostel",
      key: "PAYEE",
      ok: true,
    };
  }

  if (flags.includes("EVIDENCE_PAYEE_UNVERIFIED")) {
    return {
      detail: "Could not confirm the receiving account is yours — open it",
      key: "PAYEE",
      ok: false,
    };
  }

  // No payee flag at all: OCR is off for this deployment, or the claim predates
  // the check. Neither is a verification, and claiming one would make the badge
  // say something nobody established.
  return { detail: "Receiving account not checked — open it", key: "PAYEE", ok: false };
}

/**
 * Which way the money moved, and whether it moved (the credit-receipt fix).
 *
 * A credit-side receipt — money arriving in the resident's own wallet — used to
 * pass every check in this queue, and it passed them honestly: on such a receipt
 * the amount is right, the transaction ID is right, and the vocabulary is a
 * receipt's vocabulary. Nothing read the one word that distinguishes it.
 *
 * A confidently-read credit receipt is now refused on the form, so what reaches
 * here is the file whose direction could not be read at all.
 */
function directionCheck(event: { reviewFlags?: string[] }): ClaimCheck {
  const flags = event.reviewFlags ?? [];

  // Said first, because it explains the others. A month of rows has no single
  // direction, no single payee and no single amount, so every other amber on the
  // row follows from this one — and the reviewer's action is different too: ask
  // for the receipt rather than squint at the file.
  if (flags.includes("EVIDENCE_IS_STATEMENT")) {
    return {
      detail: "This is a full statement, not a receipt for one payment — ask for the receipt",
      key: "EVIDENCE",
      ok: false,
    };
  }

  if (flags.includes("EVIDENCE_OUTCOME_PENDING")) {
    return {
      detail: "The receipt says the transaction is still pending — wait for your statement",
      key: "EVIDENCE",
      ok: false,
    };
  }

  return {
    detail: "Could not tell whether this receipt shows money going out — open it",
    key: "EVIDENCE",
    ok: false,
  };
}

/**
 * What the *file* looks like, as distinct from what it says.
 *
 * **Counted, not listed, and that is the design.** Each of the four provenance
 * flags has an ordinary explanation on its own — a crop hides a bank balance, an
 * editor signature comes from drawing an arrow on the amount, camera EXIF means
 * a photographed paper voucher, non-standard quantization means the resident's
 * phone ships Photoshop-derived tables. Reporting any single one as a problem
 * would put an amber check on a large share of honest claims, and a check that
 * is amber on honest claims is a check reviewers learn to click past.
 *
 * Two together is where it starts to mean something, so two is the threshold.
 * One is reported in words and stays green: the reviewer can see it if they care
 * and `Approve all` is not blocked by it.
 *
 * **Never a rejection, at any count.** Four flags is a claim worth five minutes,
 * not a claim to refuse — the resident who triggers all four may simply have
 * photographed a printed voucher and cropped it in Snapseed.
 */
function fileCheck(event: { reviewFlags?: string[] }): ClaimCheck {
  const flags = event.reviewFlags ?? [];
  const observations = [
    flags.includes("EVIDENCE_EDITOR_SIGNATURE") ? "saved by an image editor" : null,
    flags.includes("EVIDENCE_FILE_RE_ENCODED") ? "re-encoded outside a phone" : null,
    flags.includes("EVIDENCE_NOT_A_SCREENSHOT") ? "a photo, not a screenshot" : null,
    flags.includes("EVIDENCE_DIMENSIONS_UNUSUAL") ? "cropped or resized" : null,
  ].filter((observation): observation is string => observation !== null);

  if (observations.length === 0) {
    return { detail: "Nothing unusual about the file itself", key: "FILE", ok: true };
  }

  if (observations.length === 1) {
    return { detail: `File is ${observations[0]}`, key: "FILE", ok: true };
  }

  return {
    detail: `File is ${observations.join(", ")} — ask for the original`,
    key: "FILE",
    ok: false,
  };
}

/**
 * The checks, in the order a reviewer reads them (target §11.4).
 *
 * All five are things a careful owner does by eye today: is there a screenshot,
 * does the amount look right, is the invoice still open, did the resident quote
 * the reference code, and has anything like this image been seen before. Doing
 * them here rather than in the screen is what lets `Approve all` mean exactly
 * "the rows that were green".
 */
export function claimChecks(
  event: {
    amount: number;
    evidenceAssetId?: Types.ObjectId | null;
    rawPayload?: { referenceNote?: string | null; transactionCode?: string | null };
    reviewFlags?: string[];
  },
  invoice: InvoiceForCheck | null,
  balance: { settled: number },
): ClaimCheck[] {
  const outstanding = invoice
    ? Math.max(0, invoice.totalAmount - balance.settled)
    : 0;
  const reference = referenceCheck(event, invoice);

  return [
    // **"Attached" was never the question** (gap fix 3). This check asserted only
    // that an asset id existed, so a claim whose evidence was a photograph of
    // anything at all went green here — and with the other four green, `Approve
    // all` settled it without a human ever opening the image.
    //
    // It now reports what the screenshot itself said: `evidence-ocr` reads the
    // image at submission and looks for the claimed amount and the transaction id
    // or reference code, leaving the flags this reads. Amber is never an
    // accusation — OCR on a re-compressed phone screenshot misses sometimes — it
    // is the row keeping itself out of a bulk sweep so that the decision happens
    // in front of the image.
    evidenceCheck(event),
    // Directly beneath the read, because it is the same file seen from the other
    // side: `EVIDENCE` is what the receipt says, `FILE` is whether the receipt
    // is a receipt. It also survives when the read does not — provenance is
    // measured at upload from bytes rather than pixels, so a claim whose
    // recogniser returned nothing still carries this one.
    fileCheck(event),
    // Then the one that carries the queue. Everything above and
    // below it verifies the payer's own assertions; this verifies where the
    // money landed, which is the only thing that makes a claim worth believing.
    payeeCheck(event),
    {
      detail: invoice
        ? event.amount === outstanding
          ? "Matches the amount outstanding"
          : `Claimed ${event.amount} against ${outstanding} outstanding`
        : "Not attached to an invoice",
      key: "AMOUNT",
      // Exact only. A part payment is legitimate and an owner may still approve
      // it — but it is a decision, and a bulk sweep must not make decisions.
      ok: Boolean(invoice) && event.amount === outstanding,
    },
    {
      detail: invoice ? `Invoice is ${invoice.status}` : "Invoice missing",
      key: "INVOICE_OPEN",
      ok: invoice !== null && ["OPEN", "PARTIAL", "OVERDUE"].includes(invoice.status),
    },
    reference,
    {
      detail: event.reviewFlags?.includes("SIMILAR_EVIDENCE")
        ? "Looks like an earlier screenshot — compare them"
        : "No similar screenshot seen",
      key: "SIMILARITY",
      ok: !event.reviewFlags?.includes("SIMILAR_EVIDENCE"),
    },
  ];
}

/** Loads a claim, scoped to the hostels the caller may act in. */
async function findClaim(
  eventId: Types.ObjectId | string,
  hostelIds: string[],
): Promise<QueueEventRow & { hostelId: Types.ObjectId }> {
  const event = await PaymentEventModel.findOne({
    _id: Types.ObjectId.isValid(String(eventId)) ? eventId : new Types.ObjectId(),
    hostelId: { $in: hostelIds },
    source: "RESIDENT_CLAIM",
  }).lean<(QueueEventRow & { hostelId: Types.ObjectId }) | null>();

  if (!event) {
    // Out-of-scope and non-existent answer identically (RULES.md §3).
    throw new FinanceServiceError("Payment claim was not found.", "CLAIM_NOT_FOUND");
  }

  return event;
}

/**
 * The claim whose money the statement import already credited.
 *
 * **Two screens, one transfer, two credits.** A resident's claim and the
 * statement row that names the same transaction are the same money, and the
 * product has an action for each: the reconcile screen's `Approve matched` settles
 * the statement row, and this queue's `Approve` settles the claim. Nothing
 * connected them, so doing both — on different days, by different people, neither
 * of whom is doing anything odd — credited one month's rent twice against one
 * invoice, and both rows are real, so the reconcile screen shows the result as
 * two correct entries.
 *
 * Re-derived at the moment of the write rather than kept as a flag on the claim,
 * for the reason ADR-4 gives generally: a flag has to be maintained by whoever
 * settles the other row, and the one code path that forgets is the one that
 * double-credits. The link already exists in the statement event's own payload.
 *
 * Refusal, not silence. The owner pressed approve on money that *did* arrive, and
 * the honest answer names where it was already recorded rather than pretending
 * nothing happened.
 */
async function assertNotAlreadyRecordedFromStatement(claim: {
  _id: Types.ObjectId;
  hostelId: Types.ObjectId;
}) {
  const recorded = await PaymentEventModel.findOne({
    hostelId: claim.hostelId,
    "rawPayload.claimEventId": claim._id.toString(),
    source: "STATEMENT_IMPORT",
    status: "SETTLED",
  })
    .select("_id")
    .lean<{ _id: Types.ObjectId } | null>();

  if (recorded) {
    throw new FinanceServiceError(
      "This payment was already recorded from your account statement, so it is credited. Approving it again would count the same transfer twice.",
      "CLAIM_ALREADY_REVIEWED",
    );
  }
}

export async function approveClaim(
  eventId: string,
  principal: ApiPrincipal,
): Promise<{ eventId: string; receiptNumber: string | null; settledAmount: number }> {
  await connectToDatabase();

  const claim = await findClaim(eventId, principal.hostelIds);

  if (claim.status !== "PENDING") {
    throw new FinanceServiceError(
      "This claim has already been reviewed.",
      "CLAIM_ALREADY_REVIEWED",
    );
  }

  await assertNotAlreadyRecordedFromStatement(claim);

  // `settleEvent` pins its filter to `status: "PENDING"`, so a double-click
  // loses the race there rather than crediting the invoice twice. It also
  // recomputes the balance and issues the receipt, in that order.
  const { balance, event, receipt } = await settleEvent(claim._id, {
    confirmation: "MANUAL_REVIEW",
    principal,
  });

  const invoice = claim.invoiceId
    ? await InvoiceModel.findOne({ _id: claim.invoiceId })
        .select("period totalAmount")
        .lean<{ period?: string; totalAmount: number } | null>()
    : null;

  // A referred resident only counts as converted once real money has been
  // verified (PHASES.md §5.1). Idempotent, and swallows its own failures.
  if (event.residentId) {
    await markReferralConverted({
      hostelId: claim.hostelId,
      paymentId: claim.invoiceId ?? claim._id,
      residentId: event.residentId,
    });

    await notifyClaimReviewed({
      hostelId: claim.hostelId,
      invoiceId: claim.invoiceId?.toString() ?? null,
      outcome: {
        kind: "verified",
        certificationCode: receipt?.certificationCode ?? null,
        method: METHOD_BY_PROVIDER[claim.provider ?? "NONE"] ?? "OTHER",
        receiptId: receipt?._id ?? null,
        receiptNumber: receipt?.receiptNumber ?? null,
        remainingAmount: Math.max(
          (invoice?.totalAmount ?? 0) - (balance?.settledAmount ?? 0),
          0,
        ),
        verifiedAmount: event.amount,
      },
      period: invoice?.period ?? null,
      residentId: event.residentId,
    });
  }

  await publishResourceChange({
    hostelIds: [claim.hostelId.toString()],
    topics: [REALTIME_TOPIC.PAYMENTS],
  });

  return {
    eventId: claim._id.toString(),
    receiptNumber: receipt?.receiptNumber ?? null,
    settledAmount: balance?.settledAmount ?? event.amount,
  };
}

export async function rejectClaim(
  eventId: string,
  rejectionReason: string,
  principal: ApiPrincipal,
): Promise<{ eventId: string; status: string }> {
  await connectToDatabase();

  const claim = await findClaim(eventId, principal.hostelIds);

  // Pinned to PENDING for the same reason approval is: whoever gets there first
  // decides, and the loser is told rather than silently overwriting a decision.
  const rejected = await PaymentEventModel.findOneAndUpdate(
    { _id: claim._id, status: "PENDING" },
    {
      $set: {
        rejectionReason,
        reviewedAt: new Date(),
        reviewedBy: principal.userId,
        status: "REJECTED",
      },
    },
    { new: true },
  ).lean<{ _id: Types.ObjectId } | null>();

  if (!rejected) {
    throw new FinanceServiceError(
      "This claim has already been reviewed.",
      "CLAIM_ALREADY_REVIEWED",
    );
  }

  await auditFinanceAction(principal, {
    action: "PAYMENT_CLAIM_REJECTED",
    // A rejection moves no money — that is exactly what it decides.
    amountAfter: 0,
    amountBefore: 0,
    entityId: claim._id,
    entityType: "PaymentEvent",
    eventId: claim._id.toString(),
    hostelId: claim.hostelId,
    invoiceId: claim.invoiceId?.toString(),
    reason: rejectionReason,
    source: "CLAIM_REVIEW",
  });

  if (claim.residentId) {
    const invoice = claim.invoiceId
      ? await InvoiceModel.findOne({ _id: claim.invoiceId })
          .select("period")
          .lean<{ period?: string } | null>()
      : null;

    await notifyClaimReviewed({
      hostelId: claim.hostelId,
      invoiceId: claim.invoiceId?.toString() ?? null,
      outcome: { kind: "rejected", rejectionReason },
      period: invoice?.period ?? null,
      residentId: claim.residentId,
    });
  }

  await publishResourceChange({
    hostelIds: [claim.hostelId.toString()],
    topics: [REALTIME_TOPIC.PAYMENTS],
  });

  return { eventId: claim._id.toString(), status: "REJECTED" };
}

export type BulkApproveResult = {
  approved: string[];
  /** Rows the sweep declined, with the check that stopped each one. */
  skipped: { eventId: string; reason: string }[];
};

/**
 * `Approve all` (target §11.4, plan item 3.5).
 *
 * **Sweeps only all-green rows, and re-derives green here.** The screen sends
 * the ids it believes are clean, but a row can go amber between render and
 * click — another approval lands, the invoice closes — and trusting the client's
 * judgement would let a bulk action approve something a reviewer was never shown
 * as safe. Every skipped row is returned with the check that stopped it, so the
 * owner sees what was left behind rather than a silently smaller count.
 *
 * Approvals run one at a time through `approveClaim`, so each keeps its own
 * receipt, audit entry and resident notification. A failure part-way leaves the
 * successful ones settled — which is correct: they are real money, and ADR-4
 * says detect rather than prevent.
 */
export async function bulkApproveClaims(
  hostelId: Types.ObjectId | string,
  eventIds: string[],
  principal: ApiPrincipal,
): Promise<BulkApproveResult> {
  await connectToDatabase();

  const queue = await listReviewQueue(hostelId, "PENDING");
  const greenById = new Map(queue.map((row) => [row.eventId, row]));

  const result: BulkApproveResult = { approved: [], skipped: [] };

  for (const eventId of eventIds) {
    const row = greenById.get(eventId);

    if (!row) {
      result.skipped.push({ eventId, reason: "No longer awaiting review." });
      continue;
    }

    const failed = row.checks.find((check) => !check.ok);

    if (failed) {
      result.skipped.push({ eventId, reason: failed.detail });
      continue;
    }

    try {
      await approveClaim(eventId, principal);
      result.approved.push(eventId);
    } catch (error) {
      result.skipped.push({
        eventId,
        reason: error instanceof Error ? error.message : "Could not approve.",
      });
    }
  }

  return result;
}
