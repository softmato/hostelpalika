import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { SubscriptionError } from "@/modules/billing/subscription.service";
import { HostelModel } from "@hostel/db/models/Hostel";
import { UserModel } from "@hostel/db/models/User";

/**
 * May this signed-in account act on this hostel's plan?
 *
 * ## Why it is not simply `hostel.ownerId === userId`
 *
 * Public registration resolves an owner from the contact details typed into the
 * form, which can land on a *different* `User` row than the account that was
 * signed in when they typed it — `findOrCreatePublicHostelOwner` will happily
 * match or mint one on an email the form supplied. `listOwnerHostelApplications`
 * already works around this by widening to every account sharing the signed-in
 * user's email or phone, and the billing guard has to widen exactly the same
 * way or an owner would see their own application on the progress page and then
 * be refused when they tried to pay for it.
 *
 * The widening is by verified-enough identity — an address or a number the
 * account already holds — not by anything the request body says, so a caller
 * cannot nominate whose hostel they would like to pay for.
 */
export async function resolveOwnedHostel(hostelId: string, userId: string) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(hostelId)) {
    throw new SubscriptionError("Invalid hostel id.", "INVALID_OBJECT_ID", 422);
  }

  const hostel = await HostelModel.findOne({
    _id: new Types.ObjectId(hostelId),
    isDeleted: { $ne: true },
  })
    .select("ownerId name slug status verificationStatus")
    .lean<{
      _id: Types.ObjectId;
      name?: string;
      ownerId?: Types.ObjectId;
      slug?: string;
      status?: string;
      verificationStatus?: string;
    } | null>();

  if (!hostel) {
    throw new SubscriptionError("Hostel not found.", "HOSTEL_NOT_FOUND", 404);
  }

  const ownerIds = await ownerIdentitiesFor(userId);

  if (!hostel.ownerId || !ownerIds.has(hostel.ownerId.toString())) {
    throw new SubscriptionError(
      "This hostel is not yours to manage.",
      "NOT_HOSTEL_OWNER",
      403,
    );
  }

  return hostel;
}

/** Every account id that is, for these purposes, the same person. */
export async function ownerIdentitiesFor(userId: string) {
  const ids = new Set<string>([userId]);

  const user = await UserModel.findById(userId)
    .select("email phone")
    .lean<{ email?: string; phone?: string } | null>();

  const or: Array<{ email?: string; phone?: string }> = [];

  if (user?.email) {
    or.push({ email: user.email.toLowerCase() });
  }

  if (user?.phone) {
    or.push({ phone: user.phone });
  }

  if (or.length === 0) {
    return ids;
  }

  const matches = await UserModel.find({ $or: or, isDeleted: { $ne: true } })
    .select("_id")
    .lean<{ _id: Types.ObjectId }[]>();

  for (const match of matches) {
    ids.add(match._id.toString());
  }

  return ids;
}
