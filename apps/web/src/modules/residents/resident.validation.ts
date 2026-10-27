import { z } from "zod";

import { hostelCalendarDay } from "@/lib/hostel-day";
import { paginationQuerySchema } from "@/lib/pagination";
import { admissionDocumentSchema, applicantPhotoSchema } from "@/modules/residents/applicant-photo";
import { residentDetailsSchema } from "@/modules/residents/resident-details";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid object id.");

/**
 * A move-in or move-out as the calendar date it is, not the instant it arrived
 * as.
 *
 * A date picker in Kathmandu serialises "3 September" as
 * `2026-09-02T18:15:00.000Z`, and every reader downstream counts UTC days — so
 * an unnormalised move-in bills the resident from the 2nd, and a move-in on the
 * 1st lands its first invoice in the *previous month*. Normalising here rather
 * than in each service means there is one edge to get right, and the stored
 * value is the one a human would read off the form.
 */
const calendarDateSchema = z.coerce.date().transform(hostelCalendarDay);

const optionalHostelScopeSchema = {
  hostelId: objectIdSchema.optional(),
};

export const residentStatusSchema = z.object({
  ...optionalHostelScopeSchema,
  status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "MOVED_OUT"]),
});

export const residentTypeSchema = z.enum(["STUDENT", "WORKING_PROFESSIONAL", "OTHER"]);

export const residentListQuerySchema = z.object({
  ...optionalHostelScopeSchema,
  ...paginationQuerySchema,
  q: z.string().trim().min(1).max(120).optional(),
  residentType: residentTypeSchema.optional(),
  status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "MOVED_OUT"]).optional(),
});

/**
 * Registering somebody does **not** set their rent.
 *
 * `monthlyFee` used to be here with `.default(0)`, and that default was a
 * standing bug rather than a convenience: `Resident.monthlyFee` is an
 * *override*, `resolveMonthlyCharge` reads zero as a deliberate free stay, and
 * a form that submits nothing therefore registered every resident on a
 * permanent rent of nothing — the exact failure the model documents at §5.1 A2.
 *
 * So the field is gone from intake. Rent comes from the rate card, and an
 * override is a separate, deliberate act on the resident's own screen where a
 * reason is recorded alongside it. An unexplained number cannot become the norm
 * again if there is nowhere at the door to type one.
 */
export const residentCreateSchema = z.object({
  ...optionalHostelScopeSchema,
  /**
   * A special monthly fee instead of the room type's rate — a short stay, a
   * relative. Every bill uses it, the first month included, and the rate card
   * never charges this resident. Needs `feeReason`.
   */
  monthlyFee: z.coerce.number().int().min(0).max(10_000_000).optional(),
  /** This resident's own admission fee, form fee and deposit — same reason as above. */
  admissionFee: z.coerce.number().int().min(0).max(10_000_000).optional(),
  formFee: z.coerce.number().int().min(0).max(10_000_000).optional(),
  /** "Short stay", "Relative", or the warden's own words. Covers every charge changed here. */
  feeReason: z.string().trim().min(3).max(120).optional(),
  /** The numbered room (`HostelRoom`), when the hostel tracks floors and rooms. */
  roomId: objectIdSchema.optional(),
  /**
   * This resident's own deposit. Omitted means "whatever the rate card says" —
   * the service fills it from the schedule rather than banking zero.
   */
  depositAmount: z.coerce.number().int().min(0).max(10_000_000).optional(),
  email: z.string().trim().email().optional(),
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  moveInDate: calendarDateSchema,
  phone: z.string().trim().min(7).max(24),
  /** Optional code of the resident who referred this one (PHASES.md §5.1). */
  referralCode: z.string().trim().min(4).max(32).optional(),
  residentType: residentTypeSchema.default("STUDENT"),
  roomType: z.string().trim().min(1).max(80),
  /** How rent is cut into bills — chosen on the last step (field review E2). */
  billingCycle: z.enum(["CALENDAR_MONTH", "SAME_DAY"]).optional(),
  /**
   * Registering somebody admits them, unless the caller says otherwise.
   *
   * This defaulted to `PENDING`, and a `PENDING` resident is not billed —
   * `findBillableResidents` bills the admitted only. So a hostel that registered
   * a resident through the web portal, which sends no status, got somebody who
   * sat on the Payments tab reading **Not billed** for ever: the intake raised
   * no first-month rent, and the monthly cron skipped them too. Nothing chased
   * it, because nothing was owed.
   *
   * `ACTIVE` is what registering a resident means in this product — the mobile
   * intake already sent it, so the two front doors disagreed. `PENDING` is still
   * a value a caller may pass on purpose, for the pre-booking that has not
   * arrived yet; marking that resident active later bills their move-in month
   * through the same path.
   */
  status: z.enum(["PENDING", "ACTIVE", "SUSPENDED", "MOVED_OUT"]).default("ACTIVE"),
  /**
   * The platform resident ID the hostel scanned to open this intake — the
   * `HH-4K7M-9XQ2` off their card, or the scan URL it encodes.
   *
   * This is how a scanned registration knows *which account* it is registering.
   * Without it the server could only re-find the person by their email address,
   * and the address it had was `primaryEmail` off their profile form — a field
   * the resident types and may edit, not the one they sign in with. So a
   * resident whose profile email drifted from their login was registered
   * successfully and never linked: their account stayed PUBLIC, and the resident
   * portal never appeared for somebody the hostel had literally just scanned.
   *
   * Optional, because the manual path has no card to read. That path still falls
   * back to matching on email.
   */
  userResidentId: z.string().trim().min(1).max(200).optional(),
  /** The application form — typed at the desk, sent through the Form QR, or read off their card. */
  details: residentDetailsSchema.optional(),
  /** The Form QR submission this intake answers; it is marked ADDED once they exist. */
  admissionFormId: objectIdSchema.optional(),
  /** Their face, taken or uploaded at the desk (anonymous upload + claim token). */
  photo: applicantPhotoSchema.optional(),
  /** Citizenship or ID scans taken at the desk. */
  documents: z.array(admissionDocumentSchema).max(4).optional(),
}).refine(
  (input) =>
    [input.monthlyFee, input.admissionFee, input.formFee, input.depositAmount].every((value) => value === undefined) ||
    Boolean(input.feeReason),
  { message: "Say why this resident pays a different fee.", path: ["feeReason"] },
);

export const residentUpdateSchema = z.object({
  ...optionalHostelScopeSchema,
  depositAmount: z.coerce.number().nonnegative().optional(),
  email: z.string().trim().email().optional(),
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  monthlyFee: z.coerce.number().nonnegative().optional(),
  moveInDate: calendarDateSchema.optional(),
  phone: z.string().trim().min(7).max(24).optional(),
  residentType: residentTypeSchema.optional(),
  roomType: z.string().trim().min(1).max(80).optional(),
});

export const guardianCreateSchema = z.object({
  email: z.string().trim().email().optional(),
  firstName: z.string().trim().min(1).max(80),
  isPrimary: z.boolean().default(false),
  lastName: z.string().trim().min(1).max(80),
  phone: z.string().trim().min(7).max(24),
  relation: z.string().trim().min(2).max(80),
});

export const emergencyContactCreateSchema = z.object({
  isPrimary: z.boolean().default(false),
  name: z.string().trim().min(2).max(120),
  phone: z.string().trim().min(7).max(24),
  relation: z.string().trim().min(2).max(80),
});
