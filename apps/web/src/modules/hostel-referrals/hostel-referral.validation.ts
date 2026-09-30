import { z } from "zod";

const months = z.coerce.number().int().min(0).max(24);
const days = z.coerce.number().int().min(0).max(365);

export const planBonusSchema = z.object({ days: days.default(0), months: months.default(0) });

/** The hostel-to-hostel program. Partner codes carry their own offer. */
export const hostelReferralSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** The hostel that registers with another hostel's code. */
  referee: planBonusSchema.default({ days: 0, months: 1 }),
  /** The hostel whose code it was. */
  referrer: planBonusSchema.default({ days: 0, months: 1 }),
});

export type HostelReferralSettings = z.infer<typeof hostelReferralSettingsSchema>;

const partnerCodeFields = z.object({
  code: z
    .string()
    .trim()
    .max(24)
    .regex(/^[a-zA-Z0-9-]*$/, "Letters and numbers only.")
    .optional(),
  commissionType: z.enum(["AMOUNT", "PERCENT"]),
  commissionValue: z.coerce.number().min(0).max(1_000_000),
  contact: z.string().trim().max(160).optional(),
  name: z.string().trim().min(2).max(120),
  note: z.string().trim().max(500).optional(),
  offerDays: days.default(0),
  offerMonths: months.default(0),
});

const percentCap = (input: { commissionType?: string; commissionValue?: number }) =>
  input.commissionType !== "PERCENT" || (input.commissionValue ?? 0) <= 100;
const percentIssue = { message: "A percent commission is 100 at most.", path: ["commissionValue"] };

export const partnerCodeCreateSchema = partnerCodeFields.refine(percentCap, percentIssue);

export const partnerCodeUpdateSchema = partnerCodeFields
  .omit({ code: true })
  .partial()
  .extend({ status: z.enum(["ACTIVE", "INACTIVE"]).optional() })
  .refine(percentCap, percentIssue);

export const hostelReferralInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  hostelId: z.string().trim().optional(),
  name: z.string().trim().max(120).optional(),
});
