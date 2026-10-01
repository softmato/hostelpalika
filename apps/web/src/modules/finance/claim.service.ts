import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import { readStoredObject } from "@/lib/uploads/verify";
import {
  isPerceptualNearDuplicate,
  systemDocumentKindFromText,
} from "@/modules/finance/evidence";
import {
  directionRefusal,
  outcomeRefusal,
  readEvidenceDirection,
} from "@/modules/finance/evidence-direction";
import {
  type EvidenceProvenance,
  provenanceFlags,
} from "@/modules/finance/evidence-provenance";
import {
  evidenceTextFlags,
  isDefinitelyNotPaymentEvidence,
  isEvidenceOcrEnabled,
  isPdfEvidence,
  readEvidence,
  type ClaimFacts,
} from "@/modules/finance/evidence-ocr";
import {
  looksLikeStatement,
  methodForProvider,
  parseReceipt,
} from "@/modules/finance/evidence-receipt";
import {
  hostelPayeeIdentity,
  payeeRefusal,
  readPayeeOnEvidence,
  type HostelPayeeIdentity,
} from "@/modules/finance/evidence-payee";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import {
  notifyAdminsOfClaim,
  notifyResidentOfClaim,
} from "@/modules/finance/finance-notify";
import { appendEvent } from "@/modules/finance/payment-event.service";
import {
  transactionCodeProblem,
  transactionCodeRequired,
} from "@/modules/finance/transaction-code";
import { txnIdFlags } from "@/modules/finance/txn-id-rules";
import { findCurrentResident } from "@/modules/residents/resident-access";
import type { ResidentRecord } from "@/modules/residents/resident-access";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelPaymentProfileModel } from "@hostel/db/models/HostelPaymentProfile";
import { InvoiceBalanceModel } from "@hostel/db/models/InvoiceBalance";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";
import type { ClaimSubmitInput } from "@/modules/finance/claim.validation";

/**
 * A resident telling the hostel they have paid (target §11.2, plan item 2.8).
 *
 * The `PaymentProof` version of this, and every hard-won guard on it, moves here
 * intact — item 0.2's asset-ownership check and item 0.3's upload verification
 * were security fixes, and a rewrite that quietly dropped them would reopen both.
 * What changes is the record it produces: a `PENDING` `PaymentEvent` rather than
 * a `PaymentProof` row plus a mutated `Payment.status`.
 *
 * A claim is **unconfirmed money**, which is the point of modelling it as an
 * event: it sits in the ledger with `status: PENDING` and contributes nothing to
 * any balance until a human settles it. Nothing has to remember to exclude it.
 */

type UsableAsset = {
  _id: Types.ObjectId;
  /** Where the bytes live, so the evidence can be re-read for OCR at claim time. */
  bucket: string;
  contentHash?: string;
  /**
   * What the decoded image measured at upload (gap fix 2). Absent for a PDF, and
   * for any image stored before the measurement existed — so a missing value is
   * "unknown", never "fine".
   */
  imageInsight?: { height?: number; nearBlank?: boolean; width?: number };
  key: string;
  mimeType?: string;
  perceptualHash?: string;
  /**
   * What the file's own container says about how it was made, measured at
   * upload. Absent on every asset stored before that measurement existed — and
   * absent means unknown, never clean.
   */
  provenance?: EvidenceProvenance;
  sizeBytes?: number;
  /** Set when the file is one this system generated — a receipt or statement. */
  systemDocumentKind?: "RECEIPT" | "STATEMENT";
};

/**
 * Refusing our own document as somebody's evidence, in one voice.
 *
 * Shared by the two detectors — the metadata read at upload and the printed-marker
 * read at submission — because they answer the same question about the same file
 * and a resident who hits one must not be told something different from a resident
 * who hits the other.
 *
 * **Non-accusatory, deliberately** (target §8.2). Downloading the wrong file is by
 * far the likeliest explanation: our receipt is the most recent, most official
 * -looking payment document most residents have on their phone, and the app
 * cheerfully emailed it to them. The sentence says which file to fetch instead.
 */
function systemDocumentRefusal(kind: "RECEIPT" | "STATEMENT"): FinanceServiceError {
  return new FinanceServiceError(
    kind === "STATEMENT"
      ? "That is your hostel statement, which we generated. Please upload the screenshot or receipt from the app you paid with."
      : "That is a receipt your hostel issued, not a record of your payment. Please upload the screenshot or receipt from the app you paid with — the one showing the money leaving your account.",
    "EVIDENCE_IS_SYSTEM_DOCUMENT",
  );
}

/**
 * Evidence a resident is allowed to submit (target §13.2/§13.3, items 0.2/0.3).
 *
 * `proofImageAssetId` was a free string that nothing checked, so a resident could
 * submit someone else's asset id as their own evidence — and, before item 0.1
 * closed the read side, could enumerate one to submit. Five properties, all
 * required:
 *
 * 1. the asset exists and is live;
 * 2. its owner is the submitting user;
 * 3. it belongs to this hostel — an asset labelled for another tenant is not
 *    evidence here even if the same person owns it;
 * 4. its upload was verified, so the bytes exist and match what was declared —
 *    and since gap fix 1, match the bytes' own container signature too;
 * 5. it is not blank: an image measured as featureless or thumbnail-sized at
 *    upload cannot be a screenshot of anything (gap fix 3);
 * 6. no other event already references it, so one screenshot settles one claim.
 */
const EVIDENCE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

export async function assertClaimAssetUsable(
  assetId: string,
  resident: { hostelId: Types.ObjectId },
  principal: ApiPrincipal,
): Promise<UsableAsset> {
  const asset = Types.ObjectId.isValid(assetId)
    ? await FileAssetModel.findOne({
        _id: assetId,
        isDeleted: false,
        status: "ACTIVE",
      }).lean<
        | (UsableAsset & {
            hostelId?: Types.ObjectId;
            ownerId?: Types.ObjectId;
            uploadCompletedAt?: Date;
          })
        | null
      >()
    : null;

  // A missing asset and someone else's asset answer identically: a resident
  // probing ids must not learn which ones exist.
  if (!asset || asset.ownerId?.toString() !== principal.userId) {
    throw new FinanceServiceError(
      "This file is not yours to submit. Upload the screenshot again.",
      "ASSET_NOT_OWNED",
    );
  }

  if (asset.hostelId && asset.hostelId.toString() !== resident.hostelId.toString()) {
    throw new FinanceServiceError(
      "This file is not yours to submit. Upload the screenshot again.",
      "ASSET_NOT_OWNED",
    );
  }

  // An asset whose bytes were never confirmed is a reservation, not a file: the
  // type and size on it are the client's own claim.
  if (!asset.uploadCompletedAt) {
    throw new FinanceServiceError(
      "This file did not finish uploading. Please upload the screenshot again.",
      "ASSET_UPLOAD_INCOMPLETE",
    );
  }

  // **An upload is evidence for the claim it was made for** (item E.8). Nothing
  // bounded the age of the asset, so a file uploaded months ago — for a claim
  // that was rejected, for a different feature, or simply abandoned — stayed
  // usable as fresh evidence forever, and the id is stable and guessable-adjacent.
  // A fortnight is far longer than the flow needs (the upload and the submit are
  // the same screen) and long enough that a resident who started a claim and
  // finished it after a holiday is not turned away.
  if (
    asset.uploadCompletedAt.getTime() <
    Date.now() - EVIDENCE_MAX_AGE_MS
  ) {
    throw new FinanceServiceError(
      "That upload has expired. Please upload the screenshot again.",
      "ASSET_UPLOAD_INCOMPLETE",
    );
  }

  // Our own receipt is not evidence that the resident paid — it is our record
  // that the hostel was paid, which is the opposite direction. It was accepted
  // before this check, and every claim check went green: a resident could
  // download September's receipt and submit it as proof for August.
  //
  // Non-accusatory, like the duplicate-evidence copy (target §8.2). Downloading
  // the wrong file is the overwhelmingly likely explanation — the receipt is the
  // most recent payment document most residents have.
  if (asset.systemDocumentKind) {
    throw systemDocumentRefusal(asset.systemDocumentKind);
  }

  // A solid-colour fill or a thumbnail-sized canvas is a legal image and cannot
  // be a payment screenshot — nothing could be read off it. Measured at upload
  // (gap fix 2) so this costs no storage round-trip, and only an *explicit*
  // measurement rejects: an asset stored before the measurement existed is
  // unknown, and unknown must not be treated as bad.
  if (asset.imageInsight?.nearBlank) {
    throw new FinanceServiceError(
      "That image is blank or too small to read. Please upload the screenshot from the app you paid with.",
      "EVIDENCE_NOT_READABLE",
    );
  }

  const alreadyUsed = await PaymentEventModel.exists({
    evidenceAssetId: asset._id,
    hostelId: resident.hostelId,
  });

  if (alreadyUsed) {
    throw new FinanceServiceError(
      "This screenshot has already been submitted. Please upload the screenshot for this payment.",
      "EVIDENCE_ALREADY_USED",
    );
  }

  return asset;
}

/**
 * A claim may not exceed what is owed by more than half (target §6.2 step 5d).
 *
 * The headroom is for the genuine cases — a resident clearing a small arrear
 * along with the month, or rounding a transfer up — while still stopping the
 * typo that turns 1,200 into 12,000. It is checked against what is *outstanding*
 * rather than the invoice total, so a second claim on a part-paid month is
 * measured against the part that is left.
 */
async function assertAmountWithinBounds(
  amount: number,
  invoice: { _id: Types.ObjectId; totalAmount: number },
) {
  if (amount <= 0) {
    throw new FinanceServiceError(
      "Enter the amount you actually paid.",
      "AMOUNT_OUT_OF_BOUNDS",
    );
  }

  const balance = await InvoiceBalanceModel.findOne({
    invoiceId: invoice._id,
  }).lean<{ settledAmount?: number } | null>();

  const outstanding = Math.max(0, invoice.totalAmount - (balance?.settledAmount ?? 0));

  // **A fully-settled invoice used to have no ceiling at all** (item E.8). The
  // guard read `outstanding > 0`, so once an invoice was paid off the bound
  // switched itself off entirely and a claim of any size passed — 1,200,000
  // against a settled 12,000 month, straight into the review queue, and if
  // approved it becomes credit on the resident's account. The invoice total is
  // the honest ceiling in that case: it is what this month could ever have cost.
  const ceiling = Math.round((outstanding > 0 ? outstanding : invoice.totalAmount) * 1.5);

  if (amount > ceiling) {
    throw new FinanceServiceError(
      outstanding > 0
        ? `That is much more than the ${outstanding} still owed on this invoice. Check the amount and try again.`
        : `That is much more than this invoice was for. Check the amount and try again.`,
      "AMOUNT_OUT_OF_BOUNDS",
    );
  }
}

/**
 * The same screenshot, re-uploaded as a new asset (target §8.1/§8.2).
 *
 * `assertClaimAssetUsable` catches the same *asset* used twice; this catches the
 * same *bytes* arriving under a fresh id, which is what actually happens — the
 * resident picks the file from their gallery again. Scoped to the hostel, always:
 * comparing hashes across hostels would leak that another hostel holds the same
 * image, which is a privacy leak dressed as a fraud control.
 *
 * **This never reaches the owner's queue** (target P7, invariant 9). Rejecting
 * at submission is the whole point — a duplicate that lands in front of a human
 * has already cost the thing the check exists to save. The copy says what to do
 * and does not accuse: an honest resident who tapped submit twice sees it far
 * more often than anyone else.
 */
async function assertEvidenceNotAlreadyClaimed(
  asset: UsableAsset,
  hostelId: Types.ObjectId,
  residentId: Types.ObjectId,
) {
  if (!asset.contentHash) return;

  const duplicate = await PaymentEventModel.findOne({
    evidenceHash: asset.contentHash,
    hostelId,
  }).lean<PriorClaim | null>();

  if (duplicate) {
    throw new FinanceServiceError(
      "This screenshot has already been submitted for a payment. If this is a different payment, upload the screenshot for that one.",
      "EVIDENCE_ALREADY_USED",
      await describePriorClaim(duplicate, residentId),
    );
  }
}

type PriorClaim = {
  invoiceId?: Types.ObjectId | null;
  occurredAt?: Date;
  residentId?: Types.ObjectId | null;
};

/**
 * When and what the duplicate collided with, for the rejection card (§11.3).
 *
 * "This screenshot was already used" leaves the resident with nowhere to go.
 * "It was submitted on 2 Jul 2026 for July rent" tells them it was last month's,
 * which is the whole difference between a dead end and a resident who goes and
 * finds the right screenshot.
 *
 * **The comment above used to say the prior claim is always the caller's own, and
 * it was wrong** (item E.8). Both lookups that reach here are scoped to the
 * *hostel*, not the resident: an evidence hash or a transaction id that collides
 * with another resident's claim is exactly the interesting case, and this then
 * told the submitting resident which month that stranger had paid for and when
 * they filed it. Two residents sharing a family bank account produce that
 * collision without anybody doing anything wrong.
 *
 * So the detail is returned only when the prior claim is the caller's. The
 * refusal itself is unchanged either way — it has to be, or the message becomes
 * an oracle for whether a given transaction id exists in the hostel — but a
 * stranger's claim yields nulls, and the resident gets the sentence without the
 * two facts that were never theirs to read.
 *
 * Best-effort on purpose: a missing period must degrade the sentence, never turn
 * a clear rejection into a 500.
 */
async function describePriorClaim(
  prior: PriorClaim,
  residentId: Types.ObjectId | string,
) {
  const empty = { priorPeriod: null, priorSubmittedAt: null };

  if (!prior.residentId || prior.residentId.toString() !== residentId.toString()) {
    return empty;
  }

  const invoice = prior.invoiceId
    ? await InvoiceModel.findById(prior.invoiceId).lean<{ period?: string } | null>()
    : null;

  return {
    priorPeriod: invoice?.period ?? null,
    priorSubmittedAt: prior.occurredAt ? new Date(prior.occurredAt).toISOString() : null,
  };
}

/**
 * A transaction id that could not be one (gap fix 3).
 *
 * Runs before the reuse lookup, so `dummy` is refused on its own terms rather
 * than on whether somebody else typed it first. Required for the methods that
 * hand the payer a reference, because a claim without one cannot ever be
 * reconciled against the provider's statement — it can only be believed, and
 * "believed" is the state this whole review pipeline exists to get out of.
 *
 * This is not fraud detection. Only the provider knows whether a well-formed id
 * corresponds to real money; until statement reconciliation matches it, the id
 * is the resident's assertion. What this removes is the placeholder.
 */
function assertTransactionCodeIsPlausible(
  transactionCode: string | null | undefined,
  paymentMethod: string,
) {
  const code = transactionCode?.trim();

  if (!code) {
    if (transactionCodeRequired(paymentMethod)) {
      throw new FinanceServiceError(
        "Enter the transaction ID from your payment. It is on the confirmation screen of the app you paid with.",
        "TXN_ID_REQUIRED",
      );
    }

    return;
  }

  // **Only where the field is an id.** For cash the same input is labelled "Who
  // did you give the cash to?" and holds a warden's name, which fails every rule
  // below by design — `OTHER` is free text for the same reason.
  if (!transactionCodeRequired(paymentMethod)) {
    return;
  }

  const problem = transactionCodeProblem(code);

  if (problem) {
    throw new FinanceServiceError(problem, "TXN_ID_NOT_PLAUSIBLE");
  }
}

/**
 * The same transaction id, typed onto a second claim (target §11.3).
 *
 * One transfer has one id, so a second claim carrying it is either a resident
 * submitting last month's payment again or a typo — and both belong here, not in
 * the owner's queue. The lookup is explicit rather than a unique index because
 * the index can only refuse: it cannot say *which* payment the id already
 * belongs to, and without that the resident has nothing to act on.
 *
 * Scoped to the hostel and the provider. Across providers an eight-digit id
 * genuinely can repeat, and refusing a real bank transfer because a wallet
 * receipt happened to share its number is a worse failure than letting a human
 * see both. `rawPayload.transactionCode` is unindexed, so the `hostelId`
 * equality carries the query — one hostel's event history, not the platform's.
 */
async function assertTransactionCodeNotReused(
  transactionCode: string | null | undefined,
  hostelId: Types.ObjectId,
  provider: string,
  residentId: Types.ObjectId,
) {
  const code = transactionCode?.trim();

  if (!code) return;

  // Cash and `OTHER` do not carry ids here — the same field holds a warden's
  // name for a cash handover. Two residents who both paid the same warden are
  // not a duplicate transaction, and telling the second one their payment was
  // "already recorded" is a support call about money that does exist.
  if (provider === "CASH" || provider === "OTHER") return;

  const duplicate = await PaymentEventModel.findOne({
    hostelId,
    provider,
    "rawPayload.transactionCode": code,
    status: { $ne: "REJECTED" },
  }).lean<PriorClaim | null>();

  if (duplicate) {
    throw new FinanceServiceError(
      `Transaction ID ${code} has already been recorded for a payment. Each payment has its own ID — check the ID on this transfer.`,
      "TXN_ID_ALREADY_CLAIMED",
      { ...(await describePriorClaim(duplicate, residentId)), transactionCode: code },
    );
  }

  await assertRejectedCodeNotRetriedForever(code, hostelId, provider, residentId);
}

/**
 * How many times one transaction id may be refused and re-submitted (item E.8).
 *
 * Rejection *must* free the id — that is what makes the reviewer's "wrong month"
 * or "unreadable screenshot" a correctable mistake rather than a dead end, and
 * the resident's next attempt carries the same real id because the transfer they
 * made has only one. Three is a genuine correction; a fourth is not somebody
 * fixing a typo.
 */
const REJECTED_CODE_RETRY_LIMIT = 3;

/**
 * The other half of the same rule: a rejected id belongs to whoever filed it.
 *
 * Scoped to the resident as well as the count, because the unbounded loophole had
 * a second edge — a rejected id was free for *anyone* in the hostel to submit, so
 * one resident could take an id off a rejected claim they had seen and file it as
 * their own. The refusal deliberately does not say whose it was.
 */
async function assertRejectedCodeNotRetriedForever(
  code: string,
  hostelId: Types.ObjectId,
  provider: string,
  residentId: Types.ObjectId,
) {
  const rejected = await PaymentEventModel.find({
    hostelId,
    provider,
    "rawPayload.transactionCode": code,
    status: "REJECTED",
  })
    .select("residentId")
    .limit(REJECTED_CODE_RETRY_LIMIT + 1)
    .lean<{ residentId?: Types.ObjectId | null }[]>();

  if (rejected.length === 0) return;

  const someoneElses = rejected.some(
    (event) => event.residentId?.toString() !== residentId.toString(),
  );

  if (someoneElses) {
    throw new FinanceServiceError(
      `Transaction ID ${code} has already been recorded for a payment. Each payment has its own ID — check the ID on this transfer.`,
      "TXN_ID_ALREADY_CLAIMED",
      { transactionCode: code },
    );
  }

  if (rejected.length >= REJECTED_CODE_RETRY_LIMIT) {
    throw new FinanceServiceError(
      `This transaction ID has been submitted and turned down ${rejected.length} times. Please speak to your hostel rather than submitting it again.`,
      "TXN_ID_ALREADY_CLAIMED",
      { transactionCode: code },
    );
  }
}

/**
 * Screenshots that merely *look* alike (plan item 3.4).
 *
 * Returns flags, never an error. A perceptual match is evidence and not proof —
 * a resident who re-crops or re-compresses the same transfer produces one
 * innocently, and so do two consecutive transfers of the same amount from the
 * same app. Auto-rejecting on it would refuse real payments, so the only
 * correct action is to put a note in front of a human who can see both images.
 */
async function similarEvidenceFlags(
  asset: UsableAsset,
  hostelId: Types.ObjectId,
): Promise<string[]> {
  if (!asset.perceptualHash) return [];

  // **Evidence only, not every asset in the hostel.** The pool used to be the
  // last 200 perceptually-hashed `FileAsset` rows of any kind, so community
  // photos, payment QRs and identity documents were all compared against a
  // payment screenshot — flagging claims for resembling a picture nobody had
  // submitted as proof of anything. A flag a reviewer cannot act on is worse
  // than no flag: it trains them to click past the amber one that matters.
  const priorEvidence = await PaymentEventModel.find({
    evidenceAssetId: { $ne: null },
    hostelId,
    source: "RESIDENT_CLAIM",
  })
    .sort({ occurredAt: -1 })
    .limit(200)
    .select("evidenceAssetId")
    .lean<{ evidenceAssetId?: Types.ObjectId | null }[]>();

  const assetIds = priorEvidence
    .map((event) => event.evidenceAssetId)
    .filter((id): id is Types.ObjectId => Boolean(id));

  if (assetIds.length === 0) return [];

  const recent = await FileAssetModel.find({
    _id: { $in: assetIds, $ne: asset._id },
    hostelId,
    perceptualHash: { $exists: true, $ne: null },
  })
    .select("perceptualHash")
    .lean<{ perceptualHash?: string }[]>();

  const similar = recent.some(
    (other) =>
      other.perceptualHash &&
      isPerceptualNearDuplicate(asset.perceptualHash!, other.perceptualHash),
  );

  return similar ? ["SIMILAR_EVIDENCE"] : [];
}

/**
 * The hostel's own accounts, for the payee check.
 *
 * Read from our database on every claim rather than cached: an owner who
 * corrects a mistyped eSewa ID must not spend a cache lifetime refusing every
 * resident who paid the corrected one. Two small indexed reads against documents
 * that are already hot.
 *
 * Failure degrades to an empty identity, which makes every payee verdict amber.
 * A database hiccup must cost a signal, never a resident's ability to file a
 * claim — the same contract the recogniser works to.
 */
async function loadPayeeIdentity(
  hostelId: Types.ObjectId,
): Promise<HostelPayeeIdentity> {
  try {
    const [profile, hostel] = await Promise.all([
      HostelPaymentProfileModel.findOne({ hostelId })
        // `qrPayee*` are not optional extras here: for a hostel that uploaded a
        // QR and typed nothing — the common case — they are the *only*
        // identifiers it has, read off the poster at upload. Projecting them
        // away leaves such a hostel `UNKNOWN` on every claim.
        .select(
          "bankAccountName bankAccountNumber displayName esewaId extraAccounts khaltiId qrPayeeName qrPayeeNumber",
        )
        .lean<{
          bankAccountName?: string | null;
          bankAccountNumber?: string | null;
          displayName?: string | null;
          esewaId?: string | null;
          extraAccounts?: Array<{ accountName?: string | null; number?: string | null }> | null;
          khaltiId?: string | null;
          qrPayeeName?: string | null;
          qrPayeeNumber?: string | null;
        } | null>(),
      HostelModel.findById(hostelId).select("name").lean<{ name?: string } | null>(),
    ]);

    return hostelPayeeIdentity(profile, hostel?.name ?? null);
  } catch {
    return { accountIds: [], names: [] };
  }
}

/**
 * Amber unless the direction was read as an outgoing payment.
 *
 * **A verified payee settles the direction**, even on a receipt that names it
 * nowhere. If the money reached an account this hostel registered, then from the
 * resident's side it left — there is no arrangement under which paying the hostel
 * is money arriving for the resident. Without this, the commonest genuine receipt
 * in Nepal (a QR merchant payment, which carries no directional word at all) is
 * amber on a hostel that has done everything right, and amber on the honest
 * majority is what teaches a reviewer to stop reading flags.
 */
function directionFlags(
  read: ReturnType<typeof readEvidenceDirection>,
  payee: ReturnType<typeof readPayeeOnEvidence>,
  receipt: ReturnType<typeof parseReceipt>,
): string[] {
  const flags: string[] = [];

  if (
    read.direction !== "DEBIT" &&
    payee.verdict !== "MATCHED" &&
    // A single-transaction receipt from a wallet or bank, with a payee on it, is
    // the payer's own copy of a payment they made. The generic reader still
    // overrules this whenever it found words either way — it only fills the
    // silence, which on these layouts is common.
    receipt.direction !== "DEBIT"
  ) {
    flags.push("EVIDENCE_DIRECTION_UNVERIFIED");
  }

  // Not a refusal — a bank transfer genuinely sits pending overnight and the
  // money does arrive. It is exactly the case where a reviewer should wait for
  // the statement rather than decide today.
  if (read.outcome === "PENDING") {
    flags.push("EVIDENCE_OUTCOME_PENDING");
  }

  return flags;
}

/**
 * The one evidence signal a payer cannot manufacture.
 *
 * `FOREIGN` raises no flag because it never becomes a claim — it is refused on
 * the form. What is left is the distinction between *verified against our own
 * account* and *we could not tell*, and only the first may go green.
 */
function payeeFlags(read: ReturnType<typeof readPayeeOnEvidence>): string[] {
  return read.verdict === "MATCHED"
    ? ["EVIDENCE_PAYEE_VERIFIED"]
    : ["EVIDENCE_PAYEE_UNVERIFIED"];
}

/**
 * What *kind* of document this is, and whether it is the one the resident said.
 *
 * Neither flag refuses. A statement genuinely does contain the payment — it just
 * cannot say which row is this month's rent, so it is a reviewer's job rather
 * than a rejection. And a provider that disagrees with the method the resident
 * tapped is far more often a mis-tap on a six-button row than anything else;
 * what it earns is a reviewer's eye, not a refusal.
 */
function documentFlags(
  receipt: ReturnType<typeof parseReceipt>,
  text: string,
  paymentMethod: string,
): string[] {
  const flags: string[] = [];

  if (receipt.shape === "STATEMENT" || looksLikeStatement(text)) {
    flags.push("EVIDENCE_IS_STATEMENT");
  }

  const method = methodForProvider(receipt.provider);

  // Only a *positive* disagreement. An unrecognised provider says nothing about
  // the method, and treating silence as a mismatch would flag every receipt whose
  // branding did not survive the recogniser.
  if (method && method !== paymentMethod) {
    flags.push("EVIDENCE_METHOD_MISMATCH");
  }

  return flags;
}

/**
 * What the image itself says (gap fix 3).
 *
 * Two layers, and the distinction is the whole point:
 *
 * - **Read.** `evidence-ocr` recognises the text on the screenshot and checks
 *   whether the claimed amount and the transaction id or reference code actually
 *   appear on it. A hit is the only signal in this system that corroborates a
 *   claim with its own evidence; a miss is amber and never a rejection, because
 *   OCR on a re-compressed phone screenshot is good rather than certain.
 * - **Not read.** An OCR run that found nothing, a model that failed to load, an
 *   image stored before it was ever measured. Nothing here can vouch for the file,
 *   so the claim is flagged rather than called green — which keeps it out of
 *   `Approve all` and puts the decision in front of a human looking at the image.
 *
 * A **PDF is read, not skipped.** It used to earn the not-checked flag on the
 * assumption that only an image could be inspected, which had it exactly backwards:
 * a wallet's or bank's PDF receipt carries its text as text, so it reads *exactly*
 * where a screenshot is guessed at. Residents whose bank only issues PDFs were the
 * ones getting no autofill and an amber flag on every claim.
 *
 * `EVIDENCE_NOT_MACHINE_CHECKED` therefore means exactly what it says, and the
 * `EVIDENCE` review check is amber whenever it is present.
 */
async function evidenceFlags(
  asset: UsableAsset,
  facts: ClaimFacts,
  identity: HostelPayeeIdentity,
  /** What the resident said on the form, for the provider cross-check. */
  paymentMethod: string,
): Promise<{
  flags: string[];
  /** The sentence to refuse with, or null. Direction, outcome and payee. */
  refusal: string | null;
  /** True only when readable text carried no trace of a payment — a refusal. */
  notPayment: boolean;
  systemDocument: "RECEIPT" | "STATEMENT" | null;
}> {
  /**
   * What the file says about itself, and it is asked *first* for a reason.
   *
   * Every other signal in this function depends on the recogniser: it needs a
   * measured image, an enabled engine, a successful fetch and a successful read,
   * and each of those has a return path below that gives up. Provenance needs
   * none of them — it is a walk over bytes already in hand, computed at upload
   * and simply read back here.
   *
   * So it survives exactly the failure that has been costing this pipeline every
   * signal it had. When the recogniser returns nothing, a claim used to carry
   * `EVIDENCE_NOT_MACHINE_CHECKED` and not one other fact; now it still carries
   * whatever the file admits about how it was made. That is the whole argument
   * for phase 5 shipping ahead of the engine swap.
   */
  const fileFlags = [
    ...provenanceFlags(asset.provenance),
    /*
     * The transaction id's shape, which is the other signal that survives a
     * failed read: it looks at a string the resident typed, not at the image.
     * Grouped with the file flags for exactly that reason — everything in this
     * list is available whether or not anything could be recognised.
     */
    ...txnIdFlags(paymentMethod, facts.transactionCode),
  ];

  const readable =
    isPdfEvidence(asset.mimeType) ||
    (asset.imageInsight?.width !== undefined &&
      asset.imageInsight?.nearBlank === false);

  if (!readable) {
    // An image stored before gap fix 2 measured one, so nothing is known about it
    // and there is nothing safe to hand a recogniser.
    return {
      flags: ["EVIDENCE_NOT_MACHINE_CHECKED", ...fileFlags],
      notPayment: false,
      refusal: null,
      systemDocument: null,
    };
  }

  // Deliberately off is not the same as failed. With OCR disabled the claim
  // carries no evidence flags and `Approve all` behaves as it did before the
  // feature existed — flagging every claim in the hostel would make the switch
  // unusable, which is how a safety feature gets turned off permanently.
  //
  // The file flags stay: they are not the recogniser's output and turning the
  // recogniser off was never a request to stop reading the file.
  if (!isEvidenceOcrEnabled()) {
    return { flags: fileFlags, notPayment: false, refusal: null, systemDocument: null };
  }

  const bytes = await readStoredObject({ bucket: asset.bucket, key: asset.key });
  const read = bytes
    ? await readEvidence(bytes, asset.mimeType)
    : { failure: "unknown" as const, result: null };
  const text = read.result?.text ?? null;

  if (text === null) {
    // The one place a claim records *why* it carries no read.
    //
    // Not on the event and not shown to anybody: it is a server log line,
    // because the question it answers is operational. A pipeline where every
    // failure looks like "the resident uploaded a bad photo" is a pipeline that
    // can be entirely broken without anyone noticing, and that is not a
    // hypothetical here — it is what happened.
    console.warn(
      `[evidence-claim] no text for asset ${asset._id.toString()}: ${read.failure}`,
    );
  }

  // No text and no flags means the recogniser never ran — disabled, unavailable,
  // or timed out. That is unread evidence, not vouched-for evidence.
  if (text === null) {
    return {
      flags: ["EVIDENCE_NOT_MACHINE_CHECKED", ...fileFlags],
      notPayment: false,
      refusal: null,
      systemDocument: null,
    };
  }

  // The three questions that come *before* "do the numbers agree", asked off the
  // same read so none of them costs a second recognition pass.
  //
  // The provider's own template runs first and the generic readers consume it:
  // a field read off a known layout beats the same field guessed at by scanning
  // the page, and on a bank's two-column voucher it is the difference between
  // knowing the payee and finding none.
  const receipt = parseReceipt(text);
  const direction = readEvidenceDirection(text);
  const payee = readPayeeOnEvidence(text, identity, receipt.payee);

  return {
    flags: [
      ...evidenceTextFlags(text, facts),
      ...directionFlags(direction, payee, receipt),
      ...payeeFlags(payee),
      ...documentFlags(receipt, text, paymentMethod),
      ...fileFlags,
    ],
    notPayment: isDefinitelyNotPaymentEvidence(text),
    // Ordered by how certain each refusal is. A failed transaction is the most
    // definite thing a receipt can say about itself, the direction is next, and
    // the payee last because it is the only one of the three that depends on the
    // hostel having configured its own accounts correctly.
    refusal:
      outcomeRefusal(direction) ?? directionRefusal(direction) ?? payeeRefusal(payee),
    // Read from what is *printed*, which is the only copy of the marker that
    // survives being screenshotted. The metadata check upstream catches the PDF
    // itself; this catches the photograph of it, which is the common case.
    systemDocument: systemDocumentKindFromText(text),
  };
}

export type SubmitClaimResult = {
  /** False when the same claim was already recorded — a replay, not a second claim. */
  created: boolean;
  eventId: string;
  status: string;
};

export async function submitClaim(
  invoiceId: string,
  input: ClaimSubmitInput,
  principal: ApiPrincipal,
): Promise<SubmitClaimResult> {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);

  const invoice = await InvoiceModel.findOne({
    _id: Types.ObjectId.isValid(invoiceId) ? invoiceId : new Types.ObjectId(),
    hostelId: resident.hostelId,
    residentId: resident._id,
  }).lean<{
    _id: Types.ObjectId;
    hostelId: Types.ObjectId;
    period?: string;
    referenceCode?: string;
    status: string;
    totalAmount: number;
  } | null>();

  if (!invoice) {
    throw new FinanceServiceError("Invoice was not found.", "INVOICE_NOT_FOUND");
  }

  if (invoice.status === "PAID") {
    throw new FinanceServiceError(
      "This invoice is already paid.",
      "INVOICE_ALREADY_PAID",
    );
  }

  if (invoice.status === "VOID") {
    throw new FinanceServiceError(
      "This invoice was cancelled.",
      "INVOICE_NOT_FOUND",
    );
  }

  const asset = await assertClaimAssetUsable(input.proofImageAssetId, resident, principal);
  const provider =
    input.paymentMethod === "BANK_TRANSFER" ? "BANK" : input.paymentMethod;

  assertTransactionCodeIsPlausible(input.transactionCode, input.paymentMethod);
  await assertAmountWithinBounds(input.amount, invoice);
  await assertEvidenceNotAlreadyClaimed(asset, invoice.hostelId, resident._id);
  await assertTransactionCodeNotReused(
    input.transactionCode,
    invoice.hostelId,
    provider,
    resident._id,
  );

  const read = await evidenceFlags(
    asset,
    {
      amount: input.amount,
      referenceCode: invoice.referenceCode ?? null,
      transactionCode: input.transactionCode ?? null,
    },
    await loadPayeeIdentity(invoice.hostelId),
    input.paymentMethod,
  );

  // Refused here rather than flagged, and it is the one OCR result that refuses.
  // Everything else this module reads off an image is a probabilistic signal
  // about somebody else's document, so a miss has to stay amber. This is a
  // marker *we* printed on a document *we* issued: a hit means the resident is
  // submitting our own receipt back to us, and no reviewer decision improves on
  // sending them to find the right file while they are still on the form.
  if (read.systemDocument) {
    throw systemDocumentRefusal(read.systemDocument);
  }

  // The second refusal, and the only other one: a file we read a page of text off
  // that mentions no provider, no money, no transaction and no date. A reviewer
  // approving a photograph of a notebook is not a decision anybody wants to make,
  // and the resident can swap the file in ten seconds.
  //
  // Narrower than the amber `EVIDENCE_NOT_A_PAYMENT_RECORD` flag on purpose — that
  // one fires on one weak signal and must stay a warning, because a real receipt
  // read badly still has to get through.
  if (read.notPayment) {
    throw new FinanceServiceError(
      "That file does not look like a payment at all — there is no app name, no amount and no transaction ID on it. Please upload the screenshot or receipt from the app you paid with.",
      "EVIDENCE_NOT_A_PAYMENT",
    );
  }

  // The three refusals that read the *kind* of transaction rather than its
  // numbers, and the only ones that can refuse a receipt whose amount, ID and
  // reference code are all genuinely correct:
  //
  // - the money went the wrong way — a credit-side receipt is proof the resident
  //   was *paid*, and it satisfied every numeric check because on such a receipt
  //   every number is right;
  // - the transaction failed or was cancelled, so nothing moved;
  // - the money went to somebody who is not this hostel.
  //
  // Each is a *positive* read of a contradiction rather than a failure to find a
  // confirmation, which is what makes refusing safe. Every uncertain case above
  // them stays amber and reaches a human.
  if (read.refusal) {
    throw new FinanceServiceError(read.refusal, "EVIDENCE_WRONG_TRANSACTION");
  }

  const reviewFlags = [
    ...(await similarEvidenceFlags(asset, invoice.hostelId)),
    ...read.flags,
  ];

  // `claim:{residentId}:{invoiceId}:{contentHash}` (§5.2). The hash is read back
  // from storage by item 0.3, never client-sent, so a double-tapped submit
  // collapses to one event by construction rather than by a check.
  const { created, event } = await appendEvent({
    amount: input.amount,
    confirmation: "UNCONFIRMED",
    evidenceAssetId: asset._id,
    evidenceHash: asset.contentHash ?? null,
    hostelId: invoice.hostelId,
    idempotencyKey: `claim:${resident._id.toString()}:${invoice._id.toString()}:${
      asset.contentHash ?? asset._id.toString()
    }`,
    invoiceId: invoice._id,
    occurredAt: input.paidAt ?? new Date(),
    provider,
    rawPayload: {
      referenceNote: input.referenceNote ?? null,
      submittedBy: principal.userId,
      // Resident-typed and unverified, so it stays out of the indexed
      // `providerTxnId`: one resident's typo must not block another's claim on a
      // uniqueness collision.
      transactionCode: input.transactionCode ?? null,
    },
    referenceCode: invoice.referenceCode ?? null,
    residentId: resident._id,
    reviewFlags,
    source: "RESIDENT_CLAIM",
    status: "PENDING",
  });

  if (created) {
    await auditFinanceAction(principal, {
      action: "PAYMENT_CLAIM_SUBMITTED",
      // No money has moved: a claim is a statement, not a settlement. Both
      // amounts are the balance, which this does not change.
      amountAfter: 0,
      amountBefore: 0,
      entityId: event._id,
      entityType: "PaymentEvent",
      eventId: event._id.toString(),
      hostelId: invoice.hostelId,
      invoiceId: invoice._id.toString(),
      source: "RESIDENT_CLAIM",
    });

    await notifyAdminsOfClaim({
      amount: input.amount,
      eventId: event._id.toString(),
      method: input.paymentMethod,
      period: invoice.period ?? null,
      invoiceReference: invoice.referenceCode ?? null,
      referenceNote: input.referenceNote ?? null,
      resident: resident as ResidentRecord,
      transactionCode: input.transactionCode ?? null,
    });

    // Both sides of the same event, in the same order every time: the hostel
    // learns there is something to review, the resident learns their upload
    // landed and that nothing is credited yet.
    await notifyResidentOfClaim({
      amount: input.amount,
      hostelId: invoice.hostelId,
      invoiceId: invoice._id.toString(),
      period: invoice.period ?? null,
      referenceCode: invoice.referenceCode ?? null,
      residentId: resident._id,
    });

    // Live-refresh every payments panel in this hostel plus the resident's own
    // screens, so the claim reaches the review queue without a reload.
    await publishResourceChange({
      hostelIds: [invoice.hostelId.toString()],
      topics: [REALTIME_TOPIC.PAYMENTS],
      userIds: [principal.userId],
    });
  }

  return { created, eventId: event._id.toString(), status: event.status };
}
