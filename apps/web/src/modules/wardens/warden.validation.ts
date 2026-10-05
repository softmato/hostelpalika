import { z } from "zod";

import { paginationQuerySchema } from "@/lib/pagination";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid object id.");

const optionalHostelScopeSchema = {
  hostelId: objectIdSchema.optional(),
};

/**
 * The canonical per-member capability list (DATABASE.md → HostelMember).
 * Stored as an array of the enabled keys on `HostelMember.permissions`, so a new
 * capability costs an entry here rather than a migration across every row.
 */
export const WARDEN_PERMISSION_KEYS = [
  "registerResidents",
  "editHostelProfile",
  "manageRooms",
  // Payments, split out of the single `verifyPayments` flag that used to cover
  // all eight money operations (target §13.4). The first three are safe for a
  // warden; the last three change what is owed, or who gets paid, and belong to
  // the hostel owner by role rather than by grant.
  "viewPayments",
  "approvePayments",
  "recordCash",
  "reversePayments",
  "manageFeeSchedule",
  "managePaymentProfile",
  "manageFood",
  "manageNotices",
  "viewComplaints",
  "updateComplaints",
  "viewNightStatus",
  "updateNightStatus",
  "manageMaintenance",
  // Add what they spent for the hostel (docs/EXPENSES_PLAN.md). Add only: the
  // hostel's totals stay with the owner by role, never by grant.
  "recordExpenses",
  // Lets this warden save an expense without a photo of the bill. Absent by
  // default — so every warden, new or existing, must attach proof until the
  // owner switches "Bill photo needed" off for them. The forms show it inverted.
  "expenseWithoutProof",
] as const;

export type WardenPermissionKey = (typeof WARDEN_PERMISSION_KEYS)[number];

/**
 * Retired keys that are still accepted on input for one release.
 *
 * `verifyPayments` is a stored value on live `HostelMember` rows. It is no
 * longer offered in the UI and the migration rewrites it, but a row the
 * migration has not reached must still round-trip through an edit form rather
 * than failing validation — and must still grant what it used to grant, minus
 * the powers that were split away from it. See `lib/warden-capability.ts`.
 */
export const DEPRECATED_WARDEN_PERMISSION_KEYS = ["verifyPayments"] as const;

export type DeprecatedWardenPermissionKey =
  (typeof DEPRECATED_WARDEN_PERMISSION_KEYS)[number];

/**
 * What a newly created warden gets. Everything except the two that change the
 * hostel itself — editing the profile and the room configuration stay with the
 * admin until they are granted deliberately.
 */
export const DEFAULT_WARDEN_PERMISSIONS: WardenPermissionKey[] = [
  "registerResidents",
  // Not `reversePayments`, `manageFeeSchedule` or `managePaymentProfile`: a new
  // warden could previously rewrite any payment amount on the day they were
  // created (current §6.1).
  "viewPayments",
  "approvePayments",
  "recordCash",
  "manageFood",
  "manageNotices",
  "viewComplaints",
  "updateComplaints",
  "viewNightStatus",
  "updateNightStatus",
  "manageMaintenance",
  // Pre-ticked in the create form, marked "Recommended". Existing wardens do
  // not get it: this list is read only when a warden is created.
  "recordExpenses",
];

const permissionsSchema = z
  .array(z.enum([...WARDEN_PERMISSION_KEYS, ...DEPRECATED_WARDEN_PERMISSION_KEYS]))
  .max(WARDEN_PERMISSION_KEYS.length + DEPRECATED_WARDEN_PERMISSION_KEYS.length);

export const wardenListQuerySchema = z.object({
  ...paginationQuerySchema,
  ...optionalHostelScopeSchema,
  status: z.enum(["ACTIVE", "INVITED", "SUSPENDED", "REMOVED"]).optional(),
});

export const wardenCreateSchema = z.object({
  ...optionalHostelScopeSchema,
  email: z.string().trim().email(),
  name: z.string().trim().min(1).max(120),
  permissions: permissionsSchema.optional(),
  phone: z.string().trim().min(7).max(24).optional(),
});

export const wardenUpdateSchema = z
  .object({
    ...optionalHostelScopeSchema,
    permissions: permissionsSchema.optional(),
    status: z.enum(["ACTIVE", "SUSPENDED"]).optional(),
  })
  .refine((value) => value.permissions !== undefined || value.status !== undefined, {
    message: "Provide permissions or status to update.",
  });
