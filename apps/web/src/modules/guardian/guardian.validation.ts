import { z } from "zod";

/**
 * What a resident may share with a guardian (PHASES.md §4.1). Every flag
 * defaults to false — sharing is opt-in, one field at a time.
 */
export const guardianPermissionsSchema = z.object({
  canViewComplaintStatus: z.boolean().default(false),
  canViewFood: z.boolean().default(false),
  canViewNotices: z.boolean().default(false),
  canViewPayments: z.boolean().default(false),
  canViewReceipts: z.boolean().default(false),
  canViewSafety: z.boolean().default(false),
});

export const DEFAULT_GUARDIAN_PERMISSIONS = guardianPermissionsSchema.parse({});

export const guardianInviteSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  permissions: guardianPermissionsSchema.default(DEFAULT_GUARDIAN_PERMISSIONS),
  phone: z.string().trim().min(6).max(32),
  relation: z.string().trim().min(2).max(40),
});

/**
 * Not `guardianPermissionsSchema.partial()`: zod keeps `.default(false)` through
 * `.partial()`, so ticking one box wrote false to every other one.
 */
export const guardianPermissionsUpdateSchema = z.object({
  canViewComplaintStatus: z.boolean().optional(),
  canViewFood: z.boolean().optional(),
  canViewNotices: z.boolean().optional(),
  canViewPayments: z.boolean().optional(),
  canViewReceipts: z.boolean().optional(),
  canViewSafety: z.boolean().optional(),
});

export const guardianInvitationAcceptSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  token: z.string().trim().min(16).max(128),
});
