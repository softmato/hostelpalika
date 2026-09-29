import { z } from "zod";

/**
 * Inputs for the existing-residents list (docs/EXISTING_RESIDENTS.md).
 *
 * Loose on purpose. A half-typed row is a normal state for this list — a warden
 * adds the name now and the rent later — so the only things refused here are
 * shapes that cannot be stored. Whether a row is *right* is the check step's job,
 * and it answers in words the screen can show under the field.
 */

const rupees = z.coerce.number().int("Write rupees without paisa.").min(0);

export const existingResidentRowSchema = z.object({
  /** The row's id when it already exists on the list; absent for a new row. */
  id: z.string().regex(/^[a-f\d]{24}$/i).optional(),
  depositPaid: rupees.default(0),
  email: z.string().trim().max(160).default(""),
  fullName: z.string().trim().max(120).default(""),
  joinedDate: z.coerce.date().nullable().default(null),
  monthlyRent: rupees.nullable().default(null),
  oldDues: rupees.default(0),
  paidTill: z
    .string()
    .regex(/^\d{4}-\d{2}$/, "Choose a month.")
    .nullable()
    .default(null),
  phone: z.string().trim().max(24).default(""),
  roomType: z.string().trim().max(80).default(""),
});

export const existingResidentRowsSchema = z.object({
  rows: z.array(existingResidentRowSchema).max(500, "A list can hold 500 residents."),
});

export const existingResidentsFileSchema = z.object({
  /** The file itself, base64. Small by design — the reader refuses over 2 MB. */
  contentBase64: z.string().min(1).max(3_000_000),
  fileName: z.string().trim().max(200).default("residents.xlsx"),
});

export const existingResidentsScopeSchema = z.object({
  hostelId: z.string().regex(/^[a-f\d]{24}$/i).optional(),
});

export type ExistingResidentRowInput = z.infer<typeof existingResidentRowSchema>;

/** One scanned person, added straight off the intake's bed step. */
export const scannedExistingResidentSchema = existingResidentRowSchema.omit({ id: true }).extend({
  userResidentId: z.string().trim().min(1).max(200).optional(),
});
