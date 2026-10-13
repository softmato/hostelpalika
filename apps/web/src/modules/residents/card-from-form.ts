import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { encryptPersonalData, personalLookupHash } from "@/lib/personal-data-crypto";
import { cardFromDetails, openDetails } from "@/modules/residents/resident-details";
import { saveResidentIdentity } from "@/modules/users/resident-identity.service";
import { residentProfileDataSchema } from "@/modules/users/resident-identity.validation";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";
import { UserResidentProfileModel } from "@hostel/db/models/UserResidentProfile";

/*
 * What the ID card editors read a profile into without a guard: the strings
 * they `.trim()` and the enums they compare. A draft holds at least these, so
 * a half-filled card opens in the editor instead of crashing it.
 */
const EDITOR_DEFAULTS = {
  bloodGroup: "UNKNOWN",
  dietaryPreference: "NO_PREFERENCE",
  fullName: "",
  gender: "",
  guardianName: "",
  guardianPhone: "",
  guardianRelation: "",
  interests: [],
  occupation: "STUDENT",
  primaryPhone: "",
};

export type CardFromForm = "DRAFT" | "KEPT" | "MADE" | "SKIPPED";

/**
 * A resident registered off the admission form gets their ID card from it the
 * moment they are registered, on the login linked then — the account their email
 * already had, or the one made for it (`openResidentLogin`).
 *
 * Everything the card needs is on the form — photo, signature, birth date,
 * gender, a guardian with a phone — and the card is saved exactly as if they
 * had filled it in: ID minted, card mailed. Anything missing (the warden's form
 * asks for less) leaves a draft instead, and the ID card editor opens filled in,
 * asking only for what is left. A card they already have is never touched.
 *
 * Never throws: the registration or sign-in it rides on has already happened.
 */
export async function cardFromAdmissionForm(
  residentId: Types.ObjectId | string,
  userId: Types.ObjectId | string,
): Promise<CardFromForm> {
  try {
    await connectToDatabase();

    const owner = new Types.ObjectId(String(userId));
    const [resident, user, existing] = await Promise.all([
      ResidentModel.findById(residentId)
        .select("detailsData firstName lastName phone photoAssetId residentType")
        .lean<{
          detailsData?: string | null;
          firstName: string;
          lastName: string;
          phone: string;
          photoAssetId?: Types.ObjectId | null;
          residentType?: string;
        } | null>(),
      UserModel.findOne({ _id: owner, isDeleted: { $ne: true } })
        .select("email")
        .lean<{ _id: Types.ObjectId; email?: string } | null>(),
      UserResidentProfileModel.findOne({ isDeleted: { $ne: true }, userId: owner })
        .select("completedAt")
        .lean<{ completedAt?: Date | null } | null>(),
    ]);
    const details = openDetails(resident?.detailsData);
    const email = user?.email?.trim().toLowerCase();

    if (!resident || !details || !email) return "SKIPPED";
    if (existing?.completedAt) return "KEPT";

    const profile = Object.fromEntries(
      Object.entries(
        cardFromDetails(details, {
          email,
          firstName: resident.firstName,
          lastName: resident.lastName,
          phone: resident.phone,
          residentType: resident.residentType,
        }),
      ).filter(([, value]) => value !== undefined),
    );
    const photoId = resident.photoAssetId ?? null;

    // The card shows only a photo its holder owns; the form's photo is theirs.
    if (photoId) {
      await FileAssetModel.updateOne({ _id: photoId }, { $set: { ownerId: owner } });
    }

    const complete = residentProfileDataSchema.safeParse(profile);

    if (complete.success && complete.data.signature && photoId) {
      try {
        await saveResidentIdentity(owner.toString(), {
          photoAssetId: photoId.toString(),
          profile: complete.data,
          sharingEnabled: true,
        });

        return "MADE";
      } catch {
        // Saved, and only the card mail after it failed: it is a card, not a draft.
        if (await UserResidentProfileModel.exists({ completedAt: { $ne: null }, isDeleted: { $ne: true }, userId: owner })) {
          return "MADE";
        }
        // Otherwise their phone is on somebody else's card, say — they settle it in the editor.
      }
    }

    await UserResidentProfileModel.updateOne(
      { userId: owner },
      {
        $set: {
          encryptedData: encryptPersonalData({ ...EDITOR_DEFAULTS, ...profile }),
          isDeleted: false,
          payloadVersion: 1,
          primaryEmailHash: personalLookupHash(email),
          sharingEnabled: true,
          updatedBy: owner,
          ...(photoId ? { photoAssetId: photoId, photoUpdatedAt: new Date() } : {}),
        },
        $setOnInsert: { createdBy: owner },
        // Only a card they had deleted reaches here with one; a draft is not a card.
        $unset: { completedAt: "" },
      },
      { upsert: true },
    );

    return "DRAFT";
  } catch {
    return "SKIPPED";
  }
}
