import { Types } from "mongoose";
import { z } from "zod";

import { payoutAccountInputSchema } from "@/modules/bookings/payout-account.validation";

const objectId = z
  .string()
  .trim()
  .refine((value) => Types.ObjectId.isValid(value), "Not a valid id.");

/**
 * A refund account has the same shape and rules as a hostel's payout account:
 * a bank account, or the mobile number an eSewa / Khalti wallet is registered to.
 */
export const refundAccountInputSchema = payoutAccountInputSchema;

export const createBookingSchema = z.object({
  /** The policy tick. Anything but `true` is not consent. */
  acceptPolicy: z.literal(true, { error: "Accept the refund policy to book." }),
  /** Slug or id of the hostel. */
  hostel: z.string().trim().min(1).max(200),
  /** A monthly bed, or a few nights paid upfront. */
  kind: z.enum(["MONTHLY", "SHORT_STAY"]).default("MONTHLY"),
  /** A short stay's dates, `YYYY-MM-DD` Nepal days. Required for `SHORT_STAY`, ignored otherwise. */
  moveIn: z.string().trim().max(10).nullish(),
  moveOut: z.string().trim().max(10).nullish(),
  /** `YYYY-MM-DD`, Nepal day. Informational: the hold decides. */
  plannedMoveIn: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2026-09-20.")
    .nullish(),
  /** The version the checkout showed. A mismatch means the policy changed. */
  policyVersion: z.string().trim().min(1).max(64),
  refundAccount: refundAccountInputSchema,
  roomType: z.string().trim().min(1).max(120),
});

export type CreateBookingInput = z.input<typeof createBookingSchema>;

export const submitBookingPaymentSchema = z.object({
  note: z.string().trim().max(500).optional(),
  proofAssetId: objectId,
  reference: z.string().trim().max(64).optional(),
});

export const reviewBookingPaymentSchema = z.object({
  approve: z.boolean(),
  note: z.string().trim().max(500).optional(),
});

export const bookingReasonSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

/** Cancelling a confirmed booking, or one that refunds nobody's mistake: say why. */
export const requiredBookingReasonSchema = z.object({
  reason: z.string().trim().min(1, "Say why.").max(500),
});

export const cancelMyBookingSchema = z.object({
  /** The refund the screen showed. If the clock moved it, the cancel is refused with the new figure. */
  expectedRefund: z.number().int().min(0).optional(),
});

/** A refund or payout that has left our account. The transaction id is the proof that matters. */
export const markTransferSentSchema = z.object({
  note: z.string().trim().max(500).optional(),
  proofAssetId: objectId.optional(),
  transactionId: z.string().trim().min(3, "Enter the transaction ID.").max(64),
});

export const bookingPauseSchema = z.object({
  paused: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});
