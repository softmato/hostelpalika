import { z } from "zod";

import { BED_TYPES } from "@hostel/shared/types/bed-type";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid object id.");

/**
 * Whole NPR rupees (ADR-1). `.int()` at the edge is the first of three gates —
 * the schema here, `assertWholeRupees` in the arithmetic, and a Mongoose
 * validator at storage — because a fraction that reaches the ledger voids the
 * exactness the whole design rests on.
 */
const wholeRupeeSchema = z
  .number()
  .int("Amount must be a whole number of rupees.")
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

/** "YYYY-MM", the period key used across billing. */
export const periodSchema = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Period must be YYYY-MM.");

/**
 * One rate, keyed by the hostel's own room type.
 *
 * `bedType` is still accepted so a client written against the old shape keeps
 * working, but the server derives it from `roomType` whenever there is one — a
 * label the client can set is a label that can contradict the room type beside
 * it. One of the two is required: a rate keyed by nothing prices nobody.
 */
const rateSchema = z
  .object({
    bedType: z.enum(BED_TYPES).optional(),
    currency: z.string().trim().max(8).optional(),
    monthlyAmount: wholeRupeeSchema,
    roomType: z.string().trim().min(1).max(80).optional(),
  })
  .refine((rate) => Boolean(rate.roomType || rate.bedType), {
    message: "A rate needs a room type.",
    path: ["roomType"],
  });

export const feeScheduleCreateSchema = z
  .object({
    admissionFee: wholeRupeeSchema.optional(),
    formFee: wholeRupeeSchema.optional(),
    depositAmount: wholeRupeeSchema.optional(),
    effectiveFrom: z.coerce.date(),
    hostelId: objectIdSchema.optional(),
    /** Comes off the admission fee for a referred resident. See the model. */
    referralAdmissionDiscount: wholeRupeeSchema.optional(),
    // At least one rate: an empty rate card prices nobody, and would fail every
    // resident with BED_TYPE_NOT_PRICED at the next billing run.
    rates: z
      .array(rateSchema)
      .min(1, "A schedule needs at least one rate.")
      .max(30)
      .refine(
        (rates) =>
          new Set(
            rates.map((rate) =>
              (rate.roomType ?? rate.bedType ?? "")
                .toUpperCase()
                .replace(/[^A-Z0-9]/g, ""),
            ),
          ).size === rates.length,
        "Each room type may appear once.",
      ),
  })
  // A discount larger than the fee it comes off would make the admission
  // invoice negative — money owed *to* somebody for moving in. Refused at the
  // edge rather than clamped, because a hostel that typed 5000 against a 2000
  // fee has made a mistake worth seeing.
  .refine(
    (input) =>
      (input.referralAdmissionDiscount ?? 0) <= (input.admissionFee ?? 0),
    {
      message: "A referral discount cannot exceed the admission fee.",
      path: ["referralAdmissionDiscount"],
    },
  );

export const feeScheduleCloseSchema = z.object({
  effectiveTo: z.coerce.date(),
  hostelId: objectIdSchema.optional(),
});

export const feeScheduleListQuerySchema = z.object({
  hostelId: objectIdSchema.optional(),
});

export type FeeScheduleCreateInput = z.infer<typeof feeScheduleCreateSchema>;
export type FeeScheduleCloseInput = z.infer<typeof feeScheduleCloseSchema>;

/**
 * A month at reduced rent — the festival discount.
 *
 * `percentOff` starts at 1, not 0: absence of a row is how "full rent" is said,
 * and a zero-percent discount is a row that claims something was decided when
 * nothing was. 100 is allowed, because a free month after a flood is a real
 * decision, and the billing run already knows how to skip a resident who owes
 * nothing rather than write a zero invoice.
 */
export const rentConcessionSaveSchema = z.object({
  hostelId: objectIdSchema.optional(),
  percentOff: z
    .number()
    .int("Use a whole percent.")
    .min(1, "Use at least 1%. Delete the discount to charge full rent.")
    .max(100),
  period: periodSchema,
  /** Named on the resident's own invoice line, so it is words, not a code. */
  reason: z.string().trim().max(60).optional(),
});

export type RentConcessionSaveInput = z.infer<typeof rentConcessionSaveSchema>;
