import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid object id.");

export const questionCallClickSchema = z.object({
  deviceType: z.enum(["web", "android", "ios"]).default("web"),
});

export const questionCallAnalyticsQuerySchema = z.object({
  endDate: z.coerce.date().optional(),
  format: z.enum(["json", "csv"]).default("json"),
  hostelId: objectIdSchema.optional(),
  startDate: z.coerce.date().optional(),
});

/** Payload QuestionCall posts back once a referred student signs up there. */
export const questionCallConversionSchema = z.object({
  clickId: objectIdSchema.optional(),
  userId: objectIdSchema.optional(),
});

/** QuestionCall trades the code a resident arrived with for who they are. */
export const questionCallSsoExchangeSchema = z.object({
  code: z.string().min(1).max(200),
});
