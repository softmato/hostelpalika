import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { claimRegistrationDocuments } from "@/lib/registration-documents";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { FoodRoutineModel } from "@hostel/db/models/FoodRoutine";
import { HostelDocumentModel } from "@hostel/db/models/HostelDocument";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelPaymentProfileModel } from "@hostel/db/models/HostelPaymentProfile";
import { HostelPayoutAccountModel } from "@hostel/db/models/HostelPayoutAccount";
import { HostelServiceError } from "@/modules/hostels/hostel.service";

/**
 * Hostel KYC: what a team-registered hostel still has to finish after it goes
 * live. Registration takes only what publishing needs; everything here is read
 * from where it already lives, so filling it in anywhere ticks it off.
 */
export const KYC_STEPS = [
  "photos",
  "documents",
  "payout",
  "payments",
  "food",
  "rules",
  "facilities",
  "location",
] as const;

export type KycStep = (typeof KYC_STEPS)[number];

/** Enough to fill the listing's cover and a first look inside. */
const MIN_PHOTOS = 3;

export function kycPercent(done: Record<KycStep, boolean>) {
  return Math.round((100 * KYC_STEPS.filter((key) => done[key]).length) / KYC_STEPS.length);
}

export async function getHostelKyc(hostelId: string | Types.ObjectId) {
  await connectToDatabase();

  const id = new Types.ObjectId(String(hostelId));
  const [hostel, documents, payout, profile, routine] = await Promise.all([
    HostelModel.findById(id).select("photos rules facilities location").lean<{
      facilities?: string[];
      location?: { lat?: number; locationSource?: string };
      photos?: { url?: string }[];
      rules?: string[];
    } | null>(),
    HostelDocumentModel.find({ hostelId: id, isDeleted: false })
      .sort({ createdAt: -1 })
      .select("documentType status fileAssetId rejectionReason")
      .lean<
        {
          _id: Types.ObjectId;
          documentType: string;
          fileAssetId?: Types.ObjectId;
          rejectionReason?: string;
          status: string;
        }[]
      >(),
    HostelPayoutAccountModel.exists({ hostelId: id }),
    HostelPaymentProfileModel.findOne({ hostelId: id })
      .select("staticQrAssetId esewaId khaltiId bankAccountNumber")
      .lean<Record<string, unknown> | null>(),
    FoodRoutineModel.findOne({ hostelId: id }).select("meals").lean<{ meals?: unknown[] } | null>(),
  ]);

  if (!hostel) {
    throw new HostelServiceError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);
  }

  // The app previews each document through `files/[assetId]/url`, which does its
  // own authorising — this only says which file and whether it is an image.
  const files = await FileAssetModel.find({
    _id: { $in: documents.flatMap((doc) => (doc.fileAssetId ? [doc.fileAssetId] : [])) },
  })
    .select("fileName mimeType")
    .lean<{ _id: Types.ObjectId; fileName?: string; mimeType?: string }[]>();
  const fileById = new Map(files.map((file) => [String(file._id), file]));

  const done: Record<KycStep, boolean> = {
    documents: documents.length > 0,
    facilities: (hostel.facilities ?? []).length > 0,
    food: (routine?.meals ?? []).length > 0,
    // A geocoded point is a guess at the neighbourhood; only a placed pin counts.
    location: hostel.location?.lat != null && hostel.location.locationSource === "MANUAL",
    payments: Boolean(
      profile &&
        (profile.staticQrAssetId || profile.esewaId || profile.khaltiId || profile.bankAccountNumber),
    ),
    payout: Boolean(payout),
    photos: (hostel.photos ?? []).filter((photo) => photo.url).length >= MIN_PHOTOS,
    rules: (hostel.rules ?? []).length > 0,
  };

  return {
    documents: documents.map((doc) => {
      const file = doc.fileAssetId ? fileById.get(String(doc.fileAssetId)) : undefined;

      return {
        fileAssetId: doc.fileAssetId ? String(doc.fileAssetId) : null,
        fileName: file?.fileName ?? null,
        id: String(doc._id),
        mimeType: file?.mimeType ?? null,
        rejectionReason: doc.rejectionReason ?? null,
        status: doc.status,
        type: doc.documentType,
      };
    }),
    // What the inline steps pre-fill from.
    facilities: hostel.facilities ?? [],
    minPhotos: MIN_PHOTOS,
    percent: kycPercent(done),
    photoCount: (hostel.photos ?? []).filter((photo) => photo.url).length,
    rules: hostel.rules ?? [],
    steps: KYC_STEPS.map((key) => ({ done: done[key], key })),
  };
}

/** The owner's own uploads. PENDING until a platform admin looks at them. */
export async function addHostelKycDocuments(
  hostelId: string | Types.ObjectId,
  userId: string,
  documents: { claimToken: string; documentType: string; fileAssetId: string }[],
) {
  await connectToDatabase();

  const id = new Types.ObjectId(String(hostelId));
  const hostel = await HostelModel.findById(id).select("ownerId").lean<{ ownerId: Types.ObjectId } | null>();

  if (!hostel) {
    throw new HostelServiceError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);
  }

  const claimed = await claimRegistrationDocuments(documents, userId);
  const actor = new Types.ObjectId(userId);

  await HostelDocumentModel.insertMany(
    claimed.map((document) => ({
      createdBy: actor,
      documentType: document.documentType,
      fileAssetId: document.fileAssetId,
      hostelId: id,
      ownerId: hostel.ownerId,
      status: "PENDING",
      updatedBy: actor,
    })),
  );

  return getHostelKyc(id);
}
