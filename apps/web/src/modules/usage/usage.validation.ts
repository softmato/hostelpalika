import { z } from "zod";

import { USAGE_CLIENTS, USAGE_EVENT_KINDS } from "@hostel/db/models/UsageEvent";

/** Six hours: a screen left open overnight is not six hours of reading. */
export const MAX_SCREEN_MS = 6 * 60 * 60 * 1000;

const usageEventSchema = z.object({
  at: z.coerce.date(),
  durationMs: z.number().int().min(0).max(MAX_SCREEN_MS).optional(),
  feature: z.string().trim().max(200).optional(),
  kind: z.enum(USAGE_EVENT_KINDS),
  screen: z.string().trim().max(200).optional(),
});

export type UsageEventInput = z.infer<typeof usageEventSchema>;

export const usageBatchSchema = z.object({
  client: z.enum(USAGE_CLIENTS),
  events: z.array(usageEventSchema).min(1).max(200),
});

export const usageAnalyticsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  userId: z
    .string()
    .regex(/^[a-f\d]{24}$/i, "Invalid object id.")
    .optional(),
});
