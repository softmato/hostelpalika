import { z } from "zod";

/** What the hostel's settings and both registration forms send. */
export const shortStaysInputSchema = z.object({
  enabled: z.boolean(),
  minNights: z.coerce.number().int().min(1).max(29),
  rates: z
    .array(
      z.object({
        dailyRate: z.coerce.number().int("Use whole rupees.").min(1),
        roomType: z.string().trim().min(1).max(80),
      }),
    )
    .max(30),
});

export type ShortStaysInput = z.infer<typeof shortStaysInputSchema>;
