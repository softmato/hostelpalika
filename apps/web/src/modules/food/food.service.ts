import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { assertHostelAccess } from "@/lib/tenant";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { FoodFeedbackModel } from "@hostel/db/models/FoodFeedback";
import { FoodPhotoModel } from "@hostel/db/models/FoodPhoto";
import {
  findCurrentResident,
  normalizeObjectId,
  serializeResidentSummary,
} from "@/modules/residents/resident-access";
import { getFoodRoutine } from "@/modules/food/food-routine.service";
import { notifyKitchenOfFoodFeedback } from "@/modules/food/kitchen-notify";
import type {
  foodFeedbackSchema,
  foodPhotoUploadSchema,
} from "@/lib/food/food.validation";

type FoodPhotoUploadInput = z.infer<typeof foodPhotoUploadSchema>;
type FoodFeedbackInput = z.infer<typeof foodFeedbackSchema>;

type FoodPhotoRecord = {
  _id: Types.ObjectId;
  caption?: string;
  date: Date;
  hostelId: Types.ObjectId;
  mealType: string;
  photoAssetId: string;
  residentId?: Types.ObjectId;
  uploadedAt: Date;
  uploadedBy: Types.ObjectId;
};

type FoodFeedbackRecord = {
  _id: Types.ObjectId;
  comment?: string;
  createdAt?: Date;
  date: Date;
  hostelId: Types.ObjectId;
  isAnonymous: boolean;
  mealType: string;
  menuId?: Types.ObjectId;
  rating: number;
  residentId: Types.ObjectId;
};

export class FoodServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "FOOD_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

export function resolveAdminHostelId(
  principal: ApiPrincipal,
  requestedHostelId?: string,
) {
  if (requestedHostelId) {
    assertHostelAccess(principal, requestedHostelId);
    return normalizeObjectId(requestedHostelId, "hostel id");
  }

  if (principal.hostelIds.length === 1) {
    return normalizeObjectId(principal.hostelIds[0], "hostel id");
  }

  throw new FoodServiceError(
    "A hostelId is required for this hostel admin action.",
    "HOSTEL_SCOPE_REQUIRED",
    422,
  );
}

function serializeFoodPhoto(photo: FoodPhotoRecord) {
  return {
    caption: photo.caption ?? "",
    date: photo.date.toISOString(),
    hostelId: photo.hostelId.toString(),
    id: photo._id.toString(),
    mealType: photo.mealType,
    photoAssetId: photo.photoAssetId,
    residentId: photo.residentId?.toString(),
    uploadedAt: photo.uploadedAt.toISOString(),
    uploadedBy: photo.uploadedBy.toString(),
  };
}

function serializeFoodFeedback(feedback: FoodFeedbackRecord) {
  return {
    comment: feedback.comment ?? "",
    createdAt: feedback.createdAt?.toISOString(),
    date: feedback.date.toISOString(),
    hostelId: feedback.hostelId.toString(),
    id: feedback._id.toString(),
    isAnonymous: feedback.isAnonymous,
    mealType: feedback.mealType,
    menuId: feedback.menuId?.toString(),
    rating: feedback.rating,
    residentId: feedback.residentId.toString(),
  };
}

async function auditFoodAction(
  principal: ApiPrincipal,
  hostelId: Types.ObjectId,
  entityId: Types.ObjectId,
  entityType: string,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await AuditLogModel.create({
    action,
    actorId: principal.userId,
    entityId: entityId.toString(),
    entityType,
    hostelId,
    metadata,
  });
}

/**
 * Three callers, three ways of knowing which hostel the photo belongs to.
 *
 * A resident's is looked up from their own record; hostel staff's comes from
 * their principal; a **cook's** is resolved by `cook.service.ts` and handed in,
 * because a cook is not hostel staff and `resolveAdminHostelId` would refuse
 * them. The scope is a parameter rather than three near-copies of this function
 * so that the audit row, the realtime publish and the serializer stay one path.
 */
export async function uploadFoodPhoto(
  input: FoodPhotoUploadInput,
  principal: ApiPrincipal,
  options: { hostelId?: Types.ObjectId; residentScoped?: boolean } = {},
) {
  await connectToDatabase();

  const resident = options.residentScoped ? await findCurrentResident(principal) : null;
  const hostelId = resident
    ? resident.hostelId
    : (options.hostelId ?? resolveAdminHostelId(principal, input.hostelId));
  const photo = await FoodPhotoModel.create({
    ...input,
    hostelId,
    residentId: resident?._id,
    uploadedBy: principal.userId,
  });

  await auditFoodAction(
    principal,
    hostelId,
    photo._id,
    "FoodPhoto",
    "FOOD_PHOTO_UPLOADED",
  );

  // Food transparency is the point of the photo feed — residents watching it
  // should see today's meal appear as it is posted.
  await publishResourceChange({
    hostelIds: [hostelId.toString()],
    topics: [REALTIME_TOPIC.FOOD],
  });

  return {
    photo: serializeFoodPhoto(photo as FoodPhotoRecord),
    resident: resident ? serializeResidentSummary(resident) : null,
  };
}

export async function listFoodForResident(principal: ApiPrincipal) {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);
  const routine = await getFoodRoutine(resident.hostelId);
  const photos = await FoodPhotoModel.find({ hostelId: resident.hostelId })
    .sort({ date: -1, uploadedAt: -1 })
    .limit(40)
    .lean<FoodPhotoRecord[]>();

  return {
    photos: photos.map(serializeFoodPhoto),
    resident: serializeResidentSummary(resident),
    routine,
  };
}

export async function submitFoodFeedback(
  input: FoodFeedbackInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);

  const feedback = await FoodFeedbackModel.create({
    ...input,
    hostelId: resident.hostelId,
    residentId: resident._id,
  });

  await auditFoodAction(
    principal,
    resident.hostelId,
    feedback._id,
    "FoodFeedback",
    "FOOD_FEEDBACK_SUBMITTED",
  );

  // The admin's food analytics panel aggregates these ratings live.
  await publishResourceChange({
    hostelIds: [resident.hostelId.toString()],
    topics: [REALTIME_TOPIC.FOOD],
  });

  /*
   * A bad plate of food reaches the person who cooked it, while they can still
   * do something about tonight. Only two stars and below — see the notifier for
   * why a push per rating would be the fastest way to get FOOD muted.
   */
  await notifyKitchenOfFoodFeedback({
    comment: input.comment,
    hostelId: resident.hostelId,
    mealType: input.mealType,
    rating: input.rating,
    residentName: `${resident.firstName} ${resident.lastName}`.trim(),
  });

  return {
    feedback: serializeFoodFeedback(feedback as FoodFeedbackRecord),
    resident: serializeResidentSummary(resident),
  };
}
