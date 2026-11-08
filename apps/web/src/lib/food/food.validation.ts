import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid object id.");

export const mealTypeSchema = z.enum(["BREAKFAST", "LUNCH", "SNACKS", "DINNER"]);

export const dayOfWeekSchema = z.enum([
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
]);

/**
 * The whole weekly routine in one payload. No dates: a routine repeats, so it
 * is keyed by day of week and saved as a single document.
 */
export const foodRoutineSaveSchema = z.object({
  hostelId: objectIdSchema.optional(),
  timings: z.partialRecord(mealTypeSchema, z.string().trim().max(80)),
  meals: z
    .array(
      z.object({
        dayOfWeek: dayOfWeekSchema,
        mealType: mealTypeSchema,
        items: z.array(z.string().trim().min(1).max(80)).min(1).max(20),
        note: z.string().trim().max(500).optional(),
      }),
    )
    .max(28),
  /** Omit or send empty items to clear it. */
  monthEndSpecial: z
    .object({
      items: z.array(z.string().trim().min(1).max(80)).max(20),
      note: z.string().trim().max(500).optional(),
    })
    .optional(),
});

export const foodPhotoUploadSchema = z.object({
  hostelId: objectIdSchema.optional(),
  mealType: mealTypeSchema,
  date: z.coerce.date(),
  photoAssetId: z.string().trim().min(1).max(240),
  caption: z.string().trim().max(240).optional(),
});

export const foodFeedbackSchema = z.object({
  date: z.coerce.date(),
  mealType: mealTypeSchema,
  rating: z.coerce.number().int().min(1).max(5),
  comment: z.string().trim().max(500).optional(),
  isAnonymous: z.boolean().default(false),
});
