import { z } from "zod";

/**
 * Resident claim and owner review inputs (plan item 2.8, target §11.2–§11.4).
 *
 * Ports `payment.validation.ts`'s proof schemas onto the ledger's vocabulary.
 * The one addition is `amount` being an integer at the boundary: whole rupees
 * are the ledger's foundation (ADR-1), and rejecting a fractional claim here
 * beats rounding one silently three layers down.
 */

export const PAYMENT_METHODS = [
  "CASH",
  "ESEWA",
  "KHALTI",
  "FONEPAY",
  "BANK_TRANSFER",
  "OTHER",
] as const;

/**
 * How far back a resident may date a payment, and how far forward (item E.8).
 *
 * `paidAt` was an unbounded `z.coerce.date()`, and it is not a cosmetic field: it
 * becomes the event's `occurredAt`, which orders the ledger, dates the receipt and
 * decides which statement period a claim belongs to. A claim dated next March sat
 * permanently beyond every statement's cut-off — invisible to the one bucket whose
 * job is to notice a claim with no money behind it.
 *
 * The forward allowance is a few hours rather than zero because a phone's clock and
 * a server's disagree, and because Nepal is on a :45 offset that a client sending
 * local time gets wrong in exactly this direction. The backward one is a year: a
 * resident settling an old arrear is real, and a bound tight enough to catch a typo
 * would refuse them.
 */
const PAID_AT_FUTURE_TOLERANCE_MS = 6 * 60 * 60 * 1000;
const PAID_AT_MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000;

const paidAtSchema = z.coerce
  .date()
  .refine((value) => value.getTime() <= Date.now() + PAID_AT_FUTURE_TOLERANCE_MS, {
    message: "That payment date is in the future. Enter the date you actually paid.",
  })
  .refine((value) => value.getTime() >= Date.now() - PAID_AT_MAX_AGE_MS, {
    message:
      "That payment date is more than a year ago. Please contact your hostel about this payment.",
  });

export const claimSubmitSchema = z.object({
  amount: z.number().int().positive(),
  /** The Android share sheet draws its own notice; a push would be a second one. */
  notifiedOnDevice: z.boolean().optional(),
  paidAt: paidAtSchema.optional(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  proofImageAssetId: z.string().trim().min(1),
  referenceNote: z.string().trim().max(500).optional(),
  transactionCode: z.string().trim().max(120).optional(),
});

/**
 * The reasons a claim may be rejected (target §11.4, plan item 3.5).
 *
 * A fixed list rather than the free-text `window.prompt()` this replaces
 * (current §5.2). Three things follow from fixing it: the resident gets a
 * sentence they can act on instead of "wrong", the reasons become countable —
 * which is what tells an owner their instructions are unclear rather than their
 * residents careless — and nobody types an accusation into a permanent record.
 *
 * `OTHER` exists because a fixed list that cannot express the real reason gets
 * worked around, so it carries a required note.
 */
export const CLAIM_REJECTION_REASONS = {
  AMOUNT_MISMATCH: "The amount does not match this invoice.",
  ALREADY_RECORDED: "This payment has already been recorded.",
  NOT_RECEIVED: "We have not received this payment yet.",
  UNREADABLE_PROOF: "The screenshot is unreadable — please send a clearer one.",
  WRONG_ACCOUNT: "The payment went to an account we do not use.",
  WRONG_INVOICE: "This payment belongs to a different month.",
  OTHER: "Other",
} as const;

export type ClaimRejectionReasonCode = keyof typeof CLAIM_REJECTION_REASONS;

export const claimRejectSchema = z.object({
  hostelId: z.string().optional(),
  /**
   * Required, and shown to the resident. A rejection they cannot act on sends
   * them straight to the hostel office to ask why.
   */
  rejectionReason: z.string().trim().min(3).max(500),
});

export const claimApproveSchema = z.object({
  hostelId: z.string().optional(),
});

export const reviewQueueQuerySchema = z.object({
  hostelId: z.string().optional(),
  status: z.enum(["PENDING", "SETTLED", "REJECTED"]).default("PENDING"),
});

export type ClaimSubmitInput = z.infer<typeof claimSubmitSchema>;
export type ClaimRejectInput = z.infer<typeof claimRejectSchema>;
export type ReviewQueueQuery = z.infer<typeof reviewQueueQuerySchema>;
