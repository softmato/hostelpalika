import { Schema, model, models } from "mongoose";

import { currencyField, positiveWholeRupees } from "@hostel/db/models/finance-fields";

/**
 * What a hostel owes the platform for a plan.
 *
 * The sibling of `Invoice`, one level up: that one is a hostel billing its
 * resident, this one is the platform billing the hostel. The design rules are
 * the same ones, for the same reasons, and are documented there — the amount is
 * the obligation, it is immutable, and **no `paidAmount` lives on it**. What has
 * been collected is the sum of `SubscriptionPayment` rows pointing here.
 *
 * ## When one is raised
 *
 * Two trigger points, deliberately different:
 *
 * - **Public** — when the owner clicks *Pay now*. Not when they choose a plan,
 *   because choosing is allowed while still unverified and an invoice raised
 *   then would be a demand for money we are not yet willing to take.
 * - **Team** — when the agent moves past the plan step, because the agent is
 *   standing in front of the owner about to collect, and the invoice is the
 *   thing they are collecting against.
 *
 * ## Everything about the plan is copied
 *
 * `planId` is kept for reporting and nothing reads back through it. See
 * `HostelSubscription` for why: the catalogue is editable, and an invoice that
 * re-derived its own total would rewrite an agreement after the fact.
 */

export const SUBSCRIPTION_INVOICE_STATUSES = [
  /** Raised, nothing collected. */
  "OPEN",
  /** Some money in, not all of it. Only reachable on a team registration. */
  "PARTIAL",
  "PAID",
  /** Withdrawn before settling. A wrong invoice is voided, never edited. */
  "VOID",
] as const;

const subscriptionInvoiceSchema = new Schema(
  {
    /** `SUB-2609-0001-4F2A`. Human-quotable, unique, never reissued. */
    invoiceNumber: { required: true, trim: true, type: String, uppercase: true },
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    subscriptionId: {
      ref: "HostelSubscription",
      required: true,
      type: Schema.Types.ObjectId,
    },
    /**
     * `PLAN` buys time on the plan. `SETUP_FEE` is the one-off fee a field
     * agent collects at registration: it has no period and no due date, and
     * settling it never starts, extends or changes the plan — it only earns
     * the agent their commission. Its plan fields name the plan chosen that
     * day, for the record; `planName` reads "Setup fee".
     */
    kind: { default: "PLAN", enum: ["PLAN", "SETUP_FEE"], type: String },
    /**
     * Pays for the plan for life (the lifetime deal) rather than for
     * `cycleMonths`. `cycle` / `cycleMonths` are still written because the
     * schema needs them, but nothing reads them on a lifetime invoice:
     * settling it in full moves the subscription to `lifetimeSince`.
     */
    lifetime: { default: false, type: Boolean },

    /* ── The plan, snapshotted at issue ────────────────────────────────── */

    planId: { required: true, trim: true, type: String },
    planName: { required: true, trim: true, type: String },
    cycle: {
      enum: ["monthly", "halfYearly", "annual"],
      required: true,
      type: String,
    },
    cycleMonths: { min: 1, required: true, type: Number },
    /** The obligation. Whole rupees, and never zero — see `positiveWholeRupees`. */
    amount: { ...positiveWholeRupees, required: true },
    currency: currencyField,

    status: {
      default: "OPEN",
      enum: SUBSCRIPTION_INVOICE_STATUSES,
      required: true,
      type: String,
    },

    /**
     * Who the document is addressed to, copied at issue.
     *
     * An owner can change the email on their account, and a reissued copy of a
     * six-month-old invoice must still show the address it was sent to.
     */
    billedTo: {
      email: { trim: true, type: String },
      hostelName: { trim: true, type: String },
      name: { trim: true, type: String },
    },

    issuedAt: { default: Date.now, type: Date },
    /** The date the full amount is expected by. */
    dueAt: { default: null, type: Date },

    /**
     * The period this invoice pays for, fixed at issue — the same pair printed
     * on the document as its service dates.
     *
     * Stored so a settlement can tell whether the period is already running. A
     * team-filed hostel is live the moment the agent files it, so its plan
     * starts then; paying the balance off days later must not start it a
     * second time, and `currentPeriodEnd` already reaching `periodEnd` is how
     * the settlement knows. Null on invoices raised before this was kept.
     */
    periodStart: { default: null, type: Date },
    periodEnd: { default: null, type: Date },

    source: { default: "PUBLIC", enum: ["PUBLIC", "TEAM"], type: String },
    /** The agent who raised it in the field. Null when the owner self-served. */
    agentId: { default: null, ref: "User", type: Schema.Types.ObjectId },

    /* ── The Softmato invoice this one is billed through ───────────── */

    /**
     * The statutory document's own number, e.g. `INV-2083/84-000010`.
     *
     * Two numbers exist for one obligation and both are kept. `invoiceNumber`
     * above is ours: allocated first, quoted by our screens and emails, and
     * what the `external_ref` on their side is derived from. This one carries
     * the fiscal year and the ledger sequence, is issued under the parent
     * company's name and PAN, and is what an accountant will ask about.
     *
     * Null means the obligation is recorded and the paper has not been raised
     * yet — a real, resumable state, not a defect. It is reached whenever the
     * API was unreachable at issue time, and the next attempt to pay raises it.
     */
    softmatoInvoiceNo: { default: null, trim: true, type: String },
    /** Their opaque id. What `POST /v1/checkout` is addressed by. */
    softmatoInvoiceId: { default: null, trim: true, type: String },

    /**
     * The rendered document, on their side.
     *
     * Null until the invoice is raised there, which is the honest
     * representation of "no PDF exists yet" — a placeholder URL would be a
     * dead link on an email claiming to carry an invoice.
     */
    documentUrl: { default: null, trim: true, type: String },

    /**
     * Softmato documents for exactly the balance, raised when part of this
     * invoice was paid where Softmato never saw it (a proof confirmed here), so
     * their due on the original document is not ours. Checkout reads its
     * amount from the document, so the balance gets its own; settling still
     * lands on this invoice. External ref `hh-sub:<ours>-B<rupees>`, so a retry
     * for the same balance gets the same document back. Kept as a list so a
     * webhook for an earlier balance still finds its invoice.
     */
    softmatoBalanceInvoices: {
      default: [],
      type: [
        {
          _id: false,
          amount: { required: true, type: Number },
          id: { required: true, trim: true, type: String },
          no: { required: true, trim: true, type: String },
        },
      ],
    },

    /* ── The document we issued ourselves, when they could not ────────── */

    /**
     * `HH-INV-2083/84-000012` — our own statutory number, allocated only when
     * Softmato was unreachable at the moment the invoice had to be raised.
     *
     * **A third field rather than a value in `softmatoInvoiceNo`.** That one
     * carries a unique index and is what an arriving webhook is matched on, so
     * a locally minted number sitting in it would make a genuine settlement
     * notification fail to find its invoice — and, if the two series ever
     * overlapped, match the wrong one. The failure would be silent and would
     * look like a payment that never happened.
     *
     * Both can be set on one invoice, and that is a normal end state rather
     * than a conflict: we issued the paper while they were down, they raised
     * theirs when the retry got through, and the hostel is entitled to see
     * both. `softmatoInvoiceNo` wins wherever exactly one document has to be
     * named, because theirs is the one in the ledger the payment landed in.
     */
    localInvoiceNo: { default: null, trim: true, type: String },
    /** When our number was allocated. What the document prints as its date. */
    localIssuedAt: { default: null, type: Date },

    voidedAt: { default: null, type: Date },
    voidedBy: { default: null, ref: "User", type: Schema.Types.ObjectId },
    voidReason: { default: null, trim: true, type: String },

    /* ── Reminders sent about it ───────────────────────────────────────── */

    /**
     * Which reminder steps have gone out on this invoice, one entry per channel.
     *
     * Recorded rather than recomputed from the date, for the reason `Invoice`'s
     * `dunning` gives: "is today the day" silently skips an owner whenever a
     * cron run is missed, while "has this step been sent yet" answers correctly
     * on a late run and only once on a double run.
     *
     * `offset` is the step's Nepal day counted from the due day — `-1` the day
     * before, `0` the day itself, `3` three days late — so an entry still means
     * the same thing after the platform edits the schedule. An entry is written
     * before its send and removed if the send fails. Empty on invoices raised
     * before reminders existed. See `plan-due-reminders.service.ts`.
     */
    reminders: {
      sent: {
        default: [],
        type: [
          {
            _id: false,
            at: { required: true, type: Date },
            channel: { enum: ["bell", "email", "push"], required: true, type: String },
            offset: { required: true, type: Number },
          },
        ],
      },
    },
  },
  { timestamps: true },
);

subscriptionInvoiceSchema.index({ invoiceNumber: 1 }, { unique: true });
subscriptionInvoiceSchema.index({ hostelId: 1, status: 1, createdAt: -1 });
subscriptionInvoiceSchema.index({ status: 1, dueAt: 1 });
subscriptionInvoiceSchema.index({ agentId: 1, createdAt: -1 });
// Our own series, when we had to issue it. Partial for the same reason theirs
// is: the number exists only on the invoices that needed one.
subscriptionInvoiceSchema.index(
  { localInvoiceNo: 1 },
  {
    partialFilterExpression: { localInvoiceNo: { $type: "string" } },
    unique: true,
  },
);
// The handle a webhook arrives carrying. Partial, because the number is only
// assigned once the invoice has actually been raised on their side.
subscriptionInvoiceSchema.index(
  { softmatoInvoiceNo: 1 },
  {
    partialFilterExpression: { softmatoInvoiceNo: { $type: "string" } },
    unique: true,
  },
);

subscriptionInvoiceSchema.index({ "softmatoBalanceInvoices.no": 1 }, { sparse: true });

export const SubscriptionInvoiceModel =
  models.SubscriptionInvoice ||
  model("SubscriptionInvoice", subscriptionInvoiceSchema);
