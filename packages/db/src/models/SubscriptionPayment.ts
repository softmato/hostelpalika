import { Schema, model, models } from "mongoose";

import { currencyField, positiveWholeRupees } from "@hostel/db/models/finance-fields";

/**
 * Money actually received against a `SubscriptionInvoice`.
 *
 * Append-only, like `PaymentEvent` one level down. Nothing here is ever edited
 * to reflect a later payment — a second instalment is a second row, and what
 * the hostel still owes is the invoice amount minus the sum of the settled rows
 * pointing at it. That is the whole reason the invoice carries no `paidAmount`.
 *
 * ## Three methods, and only one of them is on a rail
 *
 * `SOFTMATO` is money taken through the parent company's checkout — eSewa,
 * Khalti, whatever they route it to. It lands in their ledger, gets their
 * invoice number and their receipt, and we learn it happened from a signed
 * webhook. Nothing about it is asserted by a browser.
 *
 * `CASH` is the agent taking notes in the field and typing in what they took.
 * It is **deliberately off-rail**: there is no way to represent physical cash
 * on a payment API, and inventing a transaction for it would put a row in
 * somebody's ledger that no gateway can corroborate. So a cash row is our own
 * record, honest about being one — it carries no Softmato transaction number
 * and its receipt is ours, not theirs.
 *
 * Cash is the one that needs the audit trail, because it is the one where the
 * money passes through a person: `collectedBy` is required on it, so every
 * rupee collected in the field is attributable to the member of staff who put
 * their hand out for it. The team roster reads exactly this field to answer
 * "who collected how much".
 *
 * `MANUAL` is the owner scanning the platform's own collection QR from their
 * phone, paying out of their banking app, and sending back a screenshot. It is
 * the **fallback lane** while the Softmato rail is not carrying owner-initiated
 * payments, and it stays after the rail lands: there will always be an owner
 * whose bank app worked and whose checkout did not. Nothing about it is
 * asserted by a gateway, so the only thing that can turn it into money received
 * is a human on the platform side looking at the proof — which is what
 * `IN_REVIEW` below exists to represent.
 *
 * ## `PENDING` and `IN_REVIEW` are both real states, and they are not the same
 *
 * A QR payment on the rail is displayed and then waited on. Until the gateway
 * confirms, the row exists and is worth nothing — it must not count toward the
 * balance. That is `PENDING`, and what clears it is a webhook.
 *
 * `IN_REVIEW` is a `MANUAL` row whose payer has attached proof and is waiting on
 * a person. It is worth exactly as little: only `SETTLED` rows are ever summed,
 * so a claim cannot publish a hostel or shorten a due on the strength of a
 * screenshot. The distinction matters because the two are cleared by different
 * things and a platform admin's review queue is *only* the second kind — a
 * `PENDING` row in it would be an abandoned checkout somebody is being asked to
 * adjudicate.
 */

export const SUBSCRIPTION_PAYMENT_METHODS = [
  "SOFTMATO",
  "CASH",
  "MANUAL",
] as const;

export const SUBSCRIPTION_PAYMENT_STATUSES = [
  "PENDING",
  "IN_REVIEW",
  "SETTLED",
  "FAILED",
] as const;

const subscriptionPaymentSchema = new Schema(
  {
    invoiceId: {
      ref: "SubscriptionInvoice",
      required: true,
      type: Schema.Types.ObjectId,
    },
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    subscriptionId: {
      ref: "HostelSubscription",
      required: true,
      type: Schema.Types.ObjectId,
    },

    /** Whole rupees, never zero. A payment that moves nothing is a bug. */
    amount: { ...positiveWholeRupees, required: true },
    currency: currencyField,

    method: {
      enum: SUBSCRIPTION_PAYMENT_METHODS,
      required: true,
      type: String,
    },
    status: {
      default: "PENDING",
      enum: SUBSCRIPTION_PAYMENT_STATUSES,
      required: true,
      type: String,
    },

    /**
     * The staff member who took the money.
     *
     * Required in practice for `CASH` — enforced in the service rather than the
     * schema, so the guard can say *why* rather than surfacing a cast error.
     * Null when the owner paid online themselves.
     */
    collectedBy: { default: null, ref: "User", type: Schema.Types.ObjectId },
    /** The account that initiated it, staff or owner. */
    recordedBy: { default: null, ref: "User", type: Schema.Types.ObjectId },

    /** The gateway's own reference, as the receipt reports it. */
    gatewayReference: { default: null, trim: true, type: String },
    /**
     * Set on rows written while the gateway was mocked, before the Softmato
     * integration landed. Nothing writes `true` any more, and it is kept
     * because reconciliation has to be able to tell those rows apart after the
     * fact — a comment saying "these were test rows" does not survive contact
     * with a database.
     */
    isMocked: { default: false, type: Boolean },

    /* ── Softmato, on a `SOFTMATO` row ───────────────────────────── */

    /**
     * `TXN-2083/84-00000008` — **the idempotency key for the whole webhook
     * path.**
     *
     * A delivery is retried until we answer 2xx, so the same payment arrives
     * more than once as a matter of course. Keying on this, with the unique
     * index below, is what stops the second delivery issuing a second receipt
     * for one payment.
     */
    softmatoTransactionNo: { default: null, trim: true, type: String },
    /** The checkout session this attempt was opened against. 30-minute life. */
    softmatoSessionId: { default: null, trim: true, type: String },
    /** `eSewa`, `Khalti` — the display name, as the receipt reports it. */
    softmatoProvider: { default: null, trim: true, type: String },

    settledAt: { default: null, type: Date },
    failureReason: { default: null, trim: true, type: String },

    /* ── The claim, on a `MANUAL` row ──────────────────────────────────── */

    /**
     * The screenshot or receipt the owner attached — a `PAYMENT_PROOF`
     * `FileAsset`, private, scoped to their hostel.
     *
     * Required in practice for `MANUAL`, enforced in the service rather than in
     * the schema so the refusal can say *why*. A manual claim with no proof is
     * not a weaker claim, it is a message, and there is nothing for a reviewer
     * to look at.
     */
    proofAssetId: { default: null, ref: "FileAsset", type: Schema.Types.ObjectId },
    /** When the owner said they had paid. Not when the money moved. */
    claimedAt: { default: null, type: Date },
    /** Whatever the owner wanted the reviewer to know. Free text, optional. */
    claimNote: { default: null, trim: true, type: String },

    /* ── The review ────────────────────────────────────────────────────── */

    /**
     * The platform admin who approved or refused it, and when.
     *
     * Kept apart from `recordedBy`: on a manual row that is the *owner*, who
     * asserted the payment, and conflating the person making a claim with the
     * person who accepted it would leave no way to answer "who let this
     * through" — which is the whole question an audit of a manual lane asks.
     */
    reviewedBy: { default: null, ref: "User", type: Schema.Types.ObjectId },
    reviewedAt: { default: null, type: Date },
    /** What the reviewer told the owner. Carried into the outcome email. */
    reviewNote: { default: null, trim: true, type: String },

    /* ── The receipt, issued once the row settles ──────────────────────── */

    receiptNumber: { default: null, trim: true, type: String, uppercase: true },
    receiptIssuedAt: { default: null, type: Date },
    /** Rendered by the parent company's SDK. Null while that is mocked. */
    receiptDocumentUrl: { default: null, trim: true, type: String },

    /**
     * `HH-TXN-2083/84-00000008` — the number on a receipt this platform issued
     * itself, because Softmato could not be reached when the money landed.
     *
     * Kept apart from `softmatoTransactionNo` for the reason that field's own
     * unique index exists: it is the idempotency key for the entire webhook
     * path, and a locally minted number written into it would make a real
     * settlement notification arrive as a *different* transaction and post the
     * payment twice.
     *
     * Distinct from `receiptNumber` too, which is `SRC-0001-4F2A` — a per-hostel
     * handle for support to quote. This one is the statutory number: one gapless
     * platform-wide run per fiscal year, and the thing an accountant reconciles.
     */
    localTransactionNo: { default: null, trim: true, type: String },
  },
  { timestamps: true },
);

subscriptionPaymentSchema.index({ invoiceId: 1, status: 1 });
// PLAN-1: one claim in review per invoice. The claim's own check reads, then
// writes; two sent at once both passed it. This index refuses the second.
subscriptionPaymentSchema.index(
  { invoiceId: 1 },
  {
    name: "invoiceId_1_inReview",
    partialFilterExpression: { status: "IN_REVIEW" },
    unique: true,
  },
);
// The platform's manual-review queue reads exactly this: claims waiting on a
// person, oldest first, across every hostel.
subscriptionPaymentSchema.index({ status: 1, claimedAt: 1 });
subscriptionPaymentSchema.index({ hostelId: 1, createdAt: -1 });
subscriptionPaymentSchema.index({ collectedBy: 1, settledAt: -1 });
// Our own statutory series, on the rows we had to issue a receipt for.
subscriptionPaymentSchema.index(
  { localTransactionNo: 1 },
  {
    partialFilterExpression: { localTransactionNo: { $type: "string" } },
    unique: true,
  },
);
// Unique so a retried webhook delivery cannot become a second payment row.
// Partial, because only a Softmato row ever has one.
subscriptionPaymentSchema.index(
  { softmatoTransactionNo: 1 },
  {
    partialFilterExpression: { softmatoTransactionNo: { $type: "string" } },
    unique: true,
  },
);
// Partial, because the number is only assigned when a payment settles — a plain
// unique index would collide on every pending row's null.
subscriptionPaymentSchema.index(
  { receiptNumber: 1 },
  {
    partialFilterExpression: { receiptNumber: { $type: "string" } },
    unique: true,
  },
);

export const SubscriptionPaymentModel =
  models.SubscriptionPayment ||
  model("SubscriptionPayment", subscriptionPaymentSchema);

/**
 * A filter that leaves out checkout **attempts**.
 *
 * Every press of Pay writes a `SOFTMATO` row at `PENDING` before the redirect
 * (`openSubscriptionCheckout`), so an owner who closed the wallet leaves one
 * behind that stays `PENDING` for good. It is a trace of an attempt, kept for
 * support, not a payment — so no list of payments shows it. Online money shows
 * once it has settled; cash and QR claims still show while they wait on a person.
 */
export const EXCLUDE_CHECKOUT_ATTEMPTS = {
  $nor: [{ method: "SOFTMATO", status: { $ne: "SETTLED" } }],
};
