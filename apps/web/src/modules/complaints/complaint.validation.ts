import { z } from "zod";

import { paginationQuerySchema } from "@/lib/pagination";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid object id.");

export const complaintCategorySchema = z.enum([
  "FOOD",
  "ROOM",
  "MAINTENANCE",
  "SAFETY",
  "PAYMENT",
  "STAFF",
  "NOISE",
  "OTHER",
]);

export const complaintStatusSchema = z.enum([
  "PENDING",
  "IN_PROGRESS",
  "RESOLVED",
  "REJECTED",
]);

/**
 * Raising one.
 *
 * ## Why `title` and `description` are both optional now
 *
 * The resident's app asks one question — what is this about — then shows a live
 * camera and a record button. There is no title field on it, because a title is
 * a thing a form wants and a person standing in front of a blocked drain does
 * not have; `complaintTitle` derives one from whatever did arrive.
 *
 * `description` went with it because a spoken note *is* the description. The
 * pair is not optional together, though: `refine` below refuses a complaint
 * carrying neither, since a category and a photograph do not tell an admin what
 * they are looking at.
 *
 * The web form still sends both, and both still validate exactly as they did —
 * this only widens what is accepted.
 */
export const complaintCreateSchema = z
  .object({
    attachmentAssetIds: z.array(z.string().trim().min(1)).max(5).default([]),
    category: complaintCategorySchema.default("OTHER"),
    /** The phone's id for one submission, so a send queued offline and re-sent files once. */
    clientRequestId: z.string().trim().min(8).max(64).optional(),
    /**
     * Min 2 rather than the old 5: with the title gone this is the whole of what
     * was typed, and "No water" is a complete complaint at eight characters —
     * but so is "Fan", and a bound that refuses it is a bound inherited from a
     * form that also had a title.
     */
    description: z.string().trim().min(2).max(4000).optional(),
    isAnonymous: z.boolean().default(false),
    title: z.string().trim().min(2).max(160).optional(),
    /**
     * A completed `COMPLAINT_NOTE` asset — the resident saying what is wrong.
     *
     * Attached at creation only, like the maintenance one: once staff have read
     * a complaint, silently swapping the recording it was judged on is not an
     * edit.
     */
    voiceNoteAssetId: objectIdSchema.optional(),
  })
  .refine((input) => Boolean(input.description) || Boolean(input.voiceNoteAssetId), {
    message: "Say what happened, either typed or recorded.",
    path: ["description"],
  });

export const complaintListQuerySchema = z.object({
  ...paginationQuerySchema,
  category: complaintCategorySchema.optional(),
  hostelId: objectIdSchema.optional(),
  /** "overdue" = still open and past slaDueAt; "on_track" = the rest. */
  sla: z.enum(["overdue", "on_track"]).optional(),
  status: complaintStatusSchema.optional(),
});

export const complaintStatusUpdateSchema = z.object({
  hostelId: objectIdSchema.optional(),
  response: z.string().trim().min(2).max(2000).optional(),
  status: complaintStatusSchema,
});

export const complaintReplySchema = z.object({
  hostelId: objectIdSchema.optional(),
  message: z.string().trim().min(2).max(2000),
});

export const complaintResolutionConfirmSchema = z.object({
  note: z.string().trim().min(2).max(1000).optional(),
});
