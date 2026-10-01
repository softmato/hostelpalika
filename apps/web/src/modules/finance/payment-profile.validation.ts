import { z } from "zod";

/**
 * The payment profile form (target §11.8, plan item 3.1).
 *
 * Every Tier 0 field is optional *individually* — a hostel that takes only cash
 * into a bank account should not be made to invent an eSewa id — but the profile
 * as a whole has to say something, which `isPaymentProfileUsable` decides on the
 * way out rather than this schema on the way in. That split is deliberate: a
 * half-filled form must still save, or an owner who has the bank details to hand
 * and not the QR loses both.
 *
 * The Tier 1 fields are **not here.** Merchant code and secret arrive through
 * their own flow in 6.6, with the secret going to `EncryptedSecret` (ADR-6) and
 * never through a general-purpose PATCH that also writes display text.
 */

/** Empty string means "clear this field", which is different from "leave it". */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value === "" ? null : value))
    .nullable()
    .optional();

export const paymentProfileUpdateSchema = z
  .object({
    bankAccountName: optionalText(120),
    bankAccountNumber: optionalText(64),
    bankName: optionalText(120),
    /**
     * Zero is legal and means every cash entry needs a second approver. There is
     * no upper bound — a hostel that wants no maker-checker sets it high, and
     * that decision is then on the record rather than hidden in a default.
     */
    cashApprovalThreshold: z.number().int().min(0).optional(),
    displayName: optionalText(120),
    esewaId: optionalText(64),
    /** The whole list of extra accounts, replaced as one — an empty list clears it. */
    extraAccounts: z
      .array(
        z.object({
          accountName: z.string().trim().max(120).optional(),
          bankName: z.string().trim().max(120).optional(),
          kind: z.enum(["BANK", "ESEWA", "KHALTI"]),
          number: z.string().trim().min(1).max(64),
        }),
      )
      .max(6)
      .optional(),
    hostelId: z.string().optional(),
    khaltiId: optionalText(64),
    paymentInstructions: optionalText(600),
    /**
     * The name and number printed on the QR poster, when the recogniser could
     * not read them. Typing either marks the pair `MANUAL`, which is what stops
     * a later re-read of the same image from overwriting the admin's answer.
     */
    qrPayeeName: optionalText(120),
    qrPayeeNumber: optionalText(64),
    /** The uploaded QR image. Null removes it. */
    staticQrAssetId: z.string().nullable().optional(),
    statementCadenceDays: z.number().int().min(1).max(90).optional(),
  });

export type PaymentProfileUpdateInput = z.infer<typeof paymentProfileUpdateSchema>;
