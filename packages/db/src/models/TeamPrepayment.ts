import { Schema, model, models } from "mongoose";

/**
 * A plan payment a field agent takes **before** the hostel it pays for exists.
 *
 * The team form collects the money on its Plan & payment step, while the owner
 * is still at the counter: Softmato checkout opens on the agent's device, the
 * owner scans its QR, and the form comes back with the amount and reference
 * locked. Only then is the hostel published. So the payment needs somewhere to
 * live between the scan and the publish, and this is it.
 *
 * ## It is shaped to become the hostel's first invoice
 *
 * `hostelId` is reserved here, before the hostel is written, and the hostel is
 * later created with exactly that id. `invoiceNumber` comes from that reserved
 * hostel's own sequence. So the Softmato document raised for this row files the
 * customer as the hostel and carries the reference its first plan invoice would
 * have carried anyway — and at publish, `SubscriptionInvoice` adopts the
 * document instead of raising a second one for the same money.
 *
 * ## Status
 *
 * - `OPEN` — the document is raised; nothing has arrived yet.
 * - `PAID` — Softmato says it is paid (a verified webhook or our own read).
 * - `CLAIMED` — a published hostel's invoice has taken it over.
 * - `SUPERSEDED` — the agent changed the plan before anything was paid, so a
 *   new row replaced this one. Its Softmato document stays unpaid; no session
 *   is ever opened against it again.
 */

const teamPrepaymentSchema = new Schema(
  {
    agentId: { ref: "User", required: true, type: Schema.Types.ObjectId },
    /** Reserved for the hostel this pays for. Nothing exists at this id until publish. */
    hostelId: { required: true, type: Schema.Types.ObjectId },
    /** `SUB-0001-4F2A`, from the reserved hostel's own invoice sequence. */
    invoiceNumber: { required: true, trim: true, type: String, unique: true },
    /**
     * What the money is for. `SETUP_FEE` since the plan started on free months:
     * the agent collects the setup fee and the plan fields only record the plan
     * chosen. `PLAN` is a row from before that, which still publishes the old
     * way — its payment becomes the plan's first invoice. `LIFETIME` is the
     * lifetime deal's one payment: it becomes the hostel's lifetime invoice,
     * and no setup fee or free months go with it.
     */
    kind: { default: "PLAN", enum: ["PLAN", "SETUP_FEE", "LIFETIME"], type: String },

    planId: { required: true, trim: true, type: String },
    planName: { required: true, trim: true, type: String },
    cycle: { enum: ["monthly", "halfYearly", "annual"], required: true, type: String },
    cycleMonths: { required: true, type: Number },
    /** Whole rupees, priced on the server when the row was opened. */
    amount: { min: 0, required: true, type: Number },
    /**
     * What the owner pays online now, when the agent set a part amount; the
     * Softmato document is raised for this, and the rest becomes the due at
     * publish. `null` means the whole `amount`.
     */
    chargeAmount: { default: null, min: 1, type: Number },
    billedTo: {
      email: { default: null, trim: true, type: String },
      hostelName: { default: null, trim: true, type: String },
      name: { default: null, trim: true, type: String },
    },

    softmatoInvoiceId: { default: null, trim: true, type: String },
    softmatoInvoiceNo: { default: null, trim: true, type: String },

    status: {
      default: "OPEN",
      enum: ["OPEN", "PAID", "CLAIMED", "SUPERSEDED"],
      required: true,
      type: String,
    },
    paidAt: { default: null, type: Date },
    /** Softmato's `TXN-…`, when the read or webhook that confirmed it named one. */
    transactionNo: { default: null, trim: true, type: String },
    /** `Fonepay`, `eSewa` — as Softmato reports it. */
    provider: { default: null, trim: true, type: String },
    claimedAt: { default: null, type: Date },
    /**
     * The whole team form as it stood — the same object the browser keeps as
     * its draft. Money has been taken for this hostel, so its details must not
     * live only in one browser: a paid row is listed on the agent's desk and
     * reopens the form from here.
     */
    draft: { default: null, type: Schema.Types.Mixed },
  },
  { timestamps: true },
);

teamPrepaymentSchema.index(
  { softmatoInvoiceNo: 1 },
  { partialFilterExpression: { softmatoInvoiceNo: { $type: "string" } } },
);
teamPrepaymentSchema.index({ agentId: 1, status: 1 });

export const TeamPrepaymentModel =
  models.TeamPrepayment || model("TeamPrepayment", teamPrepaymentSchema);
