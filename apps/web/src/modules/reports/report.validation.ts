import { z } from "zod";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid object id.");

/**
 * What the caller wants the table as.
 *
 * CSV stays the default so every existing link and bookmark keeps working — the
 * export routes have been CSV-only since they were built, and a default of
 * `pdf` would silently change what an unchanged URL returns.
 */
export const reportExportFormatSchema = z.enum(["csv", "pdf"]).default("csv");

/**
 * How far back an export reaches, in BS months counting this one: 1, 3, 6, 12,
 * or 0 for everything. A snapshot report (occupancy, hostels by status) ignores it.
 */
export const reportExportMonthsSchema = z.coerce
  .number()
  .int()
  .refine((value) => [0, 1, 3, 6, 12].includes(value), "Choose 1, 3, 6 or 12 months, or everything.")
  .default(0);

export const platformReportExportSchema = z.object({
  format: reportExportFormatSchema,
  months: reportExportMonthsSchema,
  report: z.enum(["hostels", "residents", "payments", "complaints"]),
});

export const hostelAdminReportExportSchema = z.object({
  format: reportExportFormatSchema,
  months: reportExportMonthsSchema,
  hostelId: objectIdSchema.optional(),
  report: z.enum(["residents", "payments", "complaints", "occupancy"]),
});

export const reportQuerySchema = z.object({
  hostelId: objectIdSchema.optional(),
  month: z
    .string()
    .trim()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
});

/** A BS month (`2083-05`), defaulting to this one — see `performance-report.service.ts`. */
export const performanceReportQuerySchema = reportQuerySchema;
