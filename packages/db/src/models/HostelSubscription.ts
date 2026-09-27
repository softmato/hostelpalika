import { Schema, model, models } from "mongoose";

import { currencyField } from "@hostel/db/models/finance-fields";

/**
 * Whole rupees, or nothing at all.
 *
 * `wholeRupees` from `finance-fields` cannot be spread onto these: its
 * validator is `Number.isInteger`, which is false for `null`, so a field that
 * defaults to null fails validation the moment the document is created. That is
 * not a flaw in `wholeRupees` — every field it was written for is required, and
 * an amount that is *absent* is a different idea from an amount that is
 * fractional.
 *
 * A subscription genuinely has no price until a plan is chosen, so these three
 * need the integrality rule **and** an empty state, and they say so here rather
 * than quietly dropping the validation to get the null through.
 */
const nullableWholeRupees = {
  min: 0,
  type: Number,
  validate: {
    message: "{PATH} must be a whole number of rupees, or empty.",
    validator: (value: number | null) => value === null || Number.isInteger(value),
  },
};

/** A count of months. Not money, so it is not measured in rupees. */
const nullableCount = {
  min: 0,
  type: Number,
  validate: {
    message: "{PATH} must be a whole number, or empty.",
    validator: (value: number | null) => value === null || Number.isInteger(value),
  },
};

/**
 * What a hostel is entitled to, and how it got there.
 *
 * This is the **entitlement**, not the ledger. It answers one question — is
 * this hostel on a paid plan right now, and until when — and it deliberately
 * carries no running total of what has been paid. Money lives in
 * `SubscriptionPayment`, the obligation lives in `SubscriptionInvoice`, and
 * what is still owed is the difference between them, computed on read.
 *
 * That split is copied straight from `Invoice`, whose comment explains why at
 * length: a mutable `paidAmount` on the entitlement is a number two writers can
 * disagree about, and the disagreement is invisible until somebody is billed
 * twice or published for free.
 *
 * ## The plan is snapshotted
 *
 * `planId` survives so the platform can see what sells, but `planName`,
 * `cycle`, `monthlyRate` and `cycleTotal` are copies taken when the plan was
 * chosen, and nothing here is ever re-read through the id. The catalogue is
 * editable — a superadmin can reprice a tier or delete one outright — and a
 * subscription that re-derived its price would silently change what was agreed.
 *
 * ## Why `PENDING_SELECTION` exists
 *
 * An owner may choose a plan **before** their documents are verified: the
 * registration page lets them, on purpose, so that the moment verification
 * lands they can pay without a second visit. So a subscription row exists in a
 * state where a plan is known but no invoice has been raised, and that state
 * needs a name.
 */

export const HOSTEL_SUBSCRIPTION_STATUSES = [
  /** No plan chosen yet. The row exists because the hostel does. */
  "PENDING_SELECTION",
  /** A plan is chosen. No invoice yet — either unverified, or not asked to pay. */
  "SELECTED",
  /** Invoice raised and outstanding in full. Nothing has been collected. */
  "AWAITING_PAYMENT",
  /** Paid in full and live. */
  "ACTIVE",
  /**
   * Live, but money is still owed.
   *
   * Only a team-filed registration reaches this: our own staff gathered the
   * data, so the hostel publishes on submission and the shortfall becomes a
   * due. A public registration cannot be here, because it does not publish
   * until it has paid.
   */
  "PAST_DUE",
  /** The paid period ran out. */
  "EXPIRED",
  "CANCELLED",
] as const;

const hostelSubscriptionSchema = new Schema(
  {
    /** One live subscription per hostel — enforced by the unique index below. */
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    status: {
      default: "PENDING_SELECTION",
      enum: HOSTEL_SUBSCRIPTION_STATUSES,
      required: true,
      type: String,
    },

    /* ── The chosen plan, snapshotted ──────────────────────────────────── */

    /** Catalogue id. For reporting only — never read back through. */
    planId: { default: null, trim: true, type: String },
    planName: { default: null, trim: true, type: String },
    cycle: {
      default: null,
      enum: ["monthly", "halfYearly", "annual", null],
      type: String,
    },
    /** Months this cycle buys. Written down so a later cycle rename can't move it. */
    cycleMonths: { ...nullableCount, default: null },
    /** Rupees per month as quoted at selection. */
    monthlyRate: { ...nullableWholeRupees, default: null },
    /** What one payment on this cycle was agreed to cost, after any discount. */
    cycleTotal: { ...nullableWholeRupees, default: null },
    /**
     * The plan's free months as offered when it was chosen, then — once the
     * hostel goes live and `freeUntil` is set — what it was actually given:
     * zero when the building had already claimed its free months
     * (`FreePlanClaim`).
     */
    freeMonths: { ...nullableCount, default: null },
    /** The last instant of the free months. Null until they start, and on a hostel given none. */
    freeUntil: { default: null, type: Date },
    /** Free months already welcomed by bell + push, claimed one number at a time. */
    freeMonthsWelcomed: { default: [], type: [Number] },
    currency: currencyField,

    selectedAt: { default: null, type: Date },
    selectedBy: { default: null, ref: "User", type: Schema.Types.ObjectId },

    /* ── Who filed the registration this subscription belongs to ───────── */

    /**
     * `TEAM` is what licenses publish-before-paid. It is recorded here as well
     * as on the application because every rule that reads it — may this hostel
     * be live while owing money, may a due banner appear — is a question about
     * the subscription, and joining back to the application to answer it would
     * make the rule depend on a document the billing code otherwise never opens.
     */
    source: { default: "PUBLIC", enum: ["PUBLIC", "TEAM"], type: String },
    /** The field-team member who filed it. Null on a public registration. */
    agentId: { default: null, ref: "User", type: Schema.Types.ObjectId },

    /* ── Activation ────────────────────────────────────────────────────── */

    activatedAt: { default: null, type: Date },
    /** When the paid period ends. Null until the first activation. */
    currentPeriodEnd: { default: null, type: Date },
    /**
     * The deadline attached to a shortfall, set when a team registration
     * publishes without full payment. Null when nothing is owed.
     */
    dueBy: { default: null, type: Date },

    cancelledAt: { default: null, type: Date },
    cancelledReason: { default: null, trim: true, type: String },
  },
  { timestamps: true },
);

hostelSubscriptionSchema.index({ hostelId: 1 }, { unique: true });
hostelSubscriptionSchema.index({ status: 1, dueBy: 1 });
hostelSubscriptionSchema.index({ agentId: 1, createdAt: -1 });

export const HostelSubscriptionModel =
  models.HostelSubscription ||
  model("HostelSubscription", hostelSubscriptionSchema);
