import { z } from "zod";

/**
 * Cash and reversal inputs (plan item 2.7).
 *
 * Compare with what the deleted PATCH accepted: `paidAmount`, `paidDate`,
 * `status` and `paymentMethod`, any of which could be set to anything. Here the
 * amount is the only number the caller supplies, and it arrives with the two
 * facts that make it answerable later — who took the money, and which paper slip
 * it is on.
 */

export const recordCashSchema = z.object({
  /** Whole rupees (ADR-1). Rejected at the boundary rather than rounded. */
  amount: z.number().int().positive(),
  /** The hostel's paper receipt. Also the idempotency key, so it cannot be blank. */
  cashReceiptNumber: z.string().trim().min(1).max(64),
  /** Who physically took the money — frequently not the person typing. */
  collectedBy: z.string().trim().min(2).max(120),
  /** How the money arrived; defaults to cash. */
  method: z.enum(["CASH", "ESEWA", "KHALTI", "BANK"]).optional(),
  note: z.string().trim().max(500).optional(),
  receivedAt: z.coerce.date().optional(),
});

/**
 * A reason is mandatory and is shown to the resident verbatim. A reversal they
 * cannot explain is the same support disaster as one they were never told about
 * (target §9.3).
 */
export const reverseEventSchema = z.object({
  reason: z.string().trim().min(3).max(500),
});

export type RecordCashPayload = z.infer<typeof recordCashSchema>;
