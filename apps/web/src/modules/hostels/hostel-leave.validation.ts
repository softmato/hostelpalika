import { z } from "zod";

import { HOSTEL_LEAVE_SECTION_KEYS } from "@hostel/shared/constants/hostel-leave";

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id.");

/** The owner's form. The hold's bounds are platform config, checked in the service. */
export const hostelLeaveSubmitSchema = z.object({
  /** The owner has read that the portal closes and the data is erased after the hold. */
  confirm: z.literal(true, { message: "Please confirm you understand." }),
  holdDays: z.coerce.number().int().min(1).max(60),
  hostelId: objectId.optional(),
  reason: z.string().trim().min(3, "Tell us why you are leaving.").max(1000),
});

export const hostelLeaveApproveSchema = z.object({
  note: z.string().trim().max(1000).optional(),
  /** What is emailed to the owner. Empty sends the approval with no files. */
  sections: z.array(z.enum(HOSTEL_LEAVE_SECTION_KEYS)).max(HOSTEL_LEAVE_SECTION_KEYS.length),
});

export const hostelLeaveRejectSchema = z.object({
  note: z.string().trim().min(3, "Say why, so the owner knows.").max(1000),
});

export const hostelLeaveListSchema = z.object({
  status: z.enum(["PENDING", "APPROVED", "REJECTED", "CANCELLED", "RECLAIMED", "ALL"]).default("PENDING"),
});

export const hostelReclaimSchema = z.object({ requestId: objectId });
