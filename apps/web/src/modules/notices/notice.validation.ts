import { z } from "zod";

import { paginationQuerySchema } from "@/lib/pagination";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid object id.");

export const noticeListQuerySchema = z.object({
  ...paginationQuerySchema,
  category: z
    .enum(["GENERAL", "URGENT", "EVENT", "RULE", "MAINTENANCE", "PAYMENT", "FOOD"])
    .optional(),
  hostelId: objectIdSchema.optional(),
});

export const noticeCreateSchema = z.object({
  hostelId: objectIdSchema.optional(),
  title: z.string().trim().min(2).max(160),
  content: z.string().trim().min(2).max(4000),
  category: z
    .enum(["GENERAL", "URGENT", "EVENT", "RULE", "MAINTENANCE", "PAYMENT", "FOOD"])
    .default("GENERAL"),
  isUrgent: z.boolean().default(false),
  targetAudience: z.enum(["ALL", "RESIDENTS", "GUARDIANS"]).default("ALL"),
  publishedAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
});

/**
 * Every field optional and no default: `.partial()` alone keeps the create
 * defaults in zod 4, so editing a title reset the category, urgency and audience.
 */
export const noticeUpdateSchema = z.object({
  hostelId: objectIdSchema.optional(),
  title: noticeCreateSchema.shape.title.optional(),
  content: noticeCreateSchema.shape.content.optional(),
  category: z
    .enum(["GENERAL", "URGENT", "EVENT", "RULE", "MAINTENANCE", "PAYMENT", "FOOD"])
    .optional(),
  isUrgent: z.boolean().optional(),
  targetAudience: z.enum(["ALL", "RESIDENTS", "GUARDIANS"]).optional(),
  publishedAt: z.coerce.date().optional(),
  expiresAt: z.coerce.date().optional(),
});
