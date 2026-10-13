import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { claimRegistrationDocuments } from "@/lib/registration-documents";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { FeeScheduleModel } from "@hostel/db/models/FeeSchedule";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { FoodRoutineModel } from "@hostel/db/models/FoodRoutine";
import { HostelDocumentModel } from "@hostel/db/models/HostelDocument";
import { HostelApplicationModel } from "@hostel/db/models/HostelApplication";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelPaymentProfileModel, isPaymentProfileUsable } from "@hostel/db/models/HostelPaymentProfile";
import { HostelPayoutAccountModel } from "@hostel/db/models/HostelPayoutAccount";
import { HostelRoomModel } from "@hostel/db/models/HostelRoom";
import { HostelSettingsModel } from "@hostel/db/models/HostelSettings";
import { HostelVerificationModel } from "@hostel/db/models/HostelVerification";
import { UserModel } from "@hostel/db/models/User";
import { notifyPlatformOfPendingHostel } from "@/modules/hostels/hostel-notify";
import { HostelServiceError } from "@/modules/hostels/hostel.service";

/**
 * Hostel KYC: what a team-registered hostel still has to finish after it goes
 * live. Registration takes only what publishing needs; everything here is read
 * from where it already lives, so filling it in anywhere ticks it off.
 */
export const KYC_STEPS = [
  // Added 2026-10-11 for the quick sign-up, which files a name only
  // (docs/QUICK_SIGNUP_KYC_TRIAL.md): its address and its room types + rent.
  "details",
  "photos",
  "rates",
  // Added 2026-10 (docs/FIELD_FIXES_2026_10.md §5): hostels already at 100%
  // see the banner again until their floors and opening balance are in.
  "rooms",
  "documents",
  "payout",
  "payments",
  "opening",
  "food",
  "rules",
  "facilities",
  "location",
] as const;

export type KycStep = (typeof KYC_STEPS)[number];

/**
 * What our team needs to check a quick sign-up is a real hostel before it is
 * listed: where it is, what it looks like, what it charges, and who owns it.
 * The rest still counts toward the ring but does not hold back Submit.
 */
export const KYC_REQUIRED_STEPS: readonly KycStep[] = ["details", "photos", "rates", "documents", "location"];

/** Enough to fill the listing's cover and a first look inside. */
const MIN_PHOTOS = 3;

export function kycPercent(done: Record<KycStep, boolean>) {
  return Math.round((100 * KYC_STEPS.filter((key) => done[key]).length) / KYC_STEPS.length);
}

export async function getHostelKyc(hostelId: string | Types.ObjectId, viewerId?: string) {
  await connectToDatabase();

  const id = new Types.ObjectId(String(hostelId));
  const [hostel, documents, payout, profile, routine, rooms, settings, rateCard] = await Promise.all([
    HostelModel.findById(id).select("photos rules facilities location hostelType kyc").lean<{
      facilities?: string[];
      hostelType?: string;
      kyc?: { note?: string | null; required?: boolean; status?: string | null; submittedAt?: Date | null };
      location?: { address?: string; area?: string; city?: string; lat?: number; locationSource?: string };
      photos?: { url?: string }[];
      rules?: string[];
    } | null>(),
    HostelDocumentModel.find({ hostelId: id, isDeleted: false })
      .sort({ createdAt: -1 })
      .select("documentType status fileAssetId rejectionReason createdBy")
      .lean<
        {
          _id: Types.ObjectId;
          createdBy?: Types.ObjectId;
          documentType: string;
          fileAssetId?: Types.ObjectId;
          rejectionReason?: string;
          status: string;
        }[]
      >(),
    HostelPayoutAccountModel.exists({ hostelId: id }),
    HostelPaymentProfileModel.findOne({ hostelId: id })
      .select("staticQrAssetId esewaId khaltiId bankAccountNumber extraAccounts gateways")
      .lean<Parameters<typeof isPaymentProfileUsable>[0]>(),
    FoodRoutineModel.findOne({ hostelId: id }).select("meals").lean<{ meals?: unknown[] } | null>(),
    HostelRoomModel.countDocuments({ hostelId: id, isDeleted: false }),
    HostelSettingsModel.findOne({ hostelId: id })
      .select("openingBalance roomTracking")
      .lean<{ openingBalance?: { amount: number } | null; roomTracking?: boolean } | null>(),
    FeeScheduleModel.exists({ effectiveTo: null, hostelId: id, "rates.0": { $exists: true } }),
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
    details: Boolean(hostel.location?.area?.trim() && hostel.location?.city?.trim()),
    documents: documents.length > 0,
    facilities: (hostel.facilities ?? []).length > 0,
    food: (routine?.meals ?? []).length > 0,
    // A geocoded point is a guess at the neighbourhood; only a placed pin counts.
    location: hostel.location?.lat != null && hostel.location.locationSource === "MANUAL",
    // The same test the resident pay screen uses, so the tick and "can pay" agree.
    payments: isPaymentProfileUsable(profile),
    payout: Boolean(payout),
    photos: (hostel.photos ?? []).filter((photo) => photo.url).length >= MIN_PHOTOS,
    rates: Boolean(rateCard),
    rules: (hostel.rules ?? []).length > 0,
    // A hostel that keeps rooms by type only has nothing to number.
    rooms: settings?.roomTracking === false || rooms > 0,
    opening: Boolean(settings?.openingBalance),
  };

  const missing = KYC_REQUIRED_STEPS.filter((key) => !done[key]);
  const reviewStatus = hostel.kyc?.status ?? "DRAFT";

  return {
    // What the details step pre-fills from.
    details: {
      address: hostel.location?.address ?? "",
      area: hostel.location?.area ?? "",
      city: hostel.location?.city ?? "",
      hostelType: hostel.hostelType ?? "CO_LIVING",
    },
    documents: documents.map((doc) => {
      const file = doc.fileAssetId ? fileById.get(String(doc.fileAssetId)) : undefined;

      return {
        // Only the uploader, and only until a platform admin approves it.
        canRemove: Boolean(viewerId) && String(doc.createdBy) === viewerId && doc.status !== "APPROVED",
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
    /** The review. `null` for a hostel that never needed one (every one before the quick sign-up). */
    review: hostel.kyc?.required
      ? {
          canSubmit: missing.length === 0 && (reviewStatus === "DRAFT" || reviewStatus === "REJECTED"),
          missing,
          note: reviewStatus === "REJECTED" ? (hostel.kyc.note ?? null) : null,
          status: reviewStatus,
          submittedAt: hostel.kyc.submittedAt?.toISOString() ?? null,
        }
      : null,
    rules: hostel.rules ?? [],
    steps: KYC_STEPS.map((key) => ({
      done: done[key],
      key,
      required: Boolean(hostel.kyc?.required) && KYC_REQUIRED_STEPS.includes(key),
    })),
  };
}

/**
 * Sends a quick sign-up's KYC to our team. The hostel joins the platform's
 * review queue (`PENDING_APPROVAL`, the same queue public registrations used),
 * and stays editable until a decision lands.
 */
export async function submitHostelKyc(hostelId: string | Types.ObjectId, userId: string) {
  await connectToDatabase();

  const id = new Types.ObjectId(String(hostelId));
  const kyc = await getHostelKyc(id, userId);

  if (!kyc.review) {
    throw new HostelServiceError("This hostel is already verified.", "KYC_NOT_REQUIRED", 409);
  }

  if (kyc.review.status === "SUBMITTED") return kyc;

  if (kyc.review.status === "APPROVED") {
    throw new HostelServiceError("Your KYC is already approved.", "KYC_ALREADY_APPROVED", 409);
  }

  if (kyc.review.missing.length > 0) {
    throw new HostelServiceError("Finish every required section before you submit.", "KYC_INCOMPLETE", 422);
  }

  const hostel = await HostelModel.findOneAndUpdate(
    { _id: id, "kyc.required": true, "kyc.status": { $ne: "APPROVED" } },
    {
      $set: {
        "kyc.note": null,
        "kyc.status": "SUBMITTED",
        "kyc.submittedAt": new Date(),
        status: "PENDING_APPROVAL",
        updatedBy: userId,
        verificationStatus: "PENDING",
      },
    },
    { new: true },
  ).lean<{
    _id: Types.ObjectId;
    contact?: { phone?: string };
    location?: { city?: string };
    name: string;
    ownerId: Types.ObjectId;
  } | null>();

  if (!hostel) {
    throw new HostelServiceError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);
  }

  const owner = await UserModel.findById(hostel.ownerId)
    .select("email name phone")
    .lean<{ email?: string; name?: string; phone?: string } | null>();
  const snapshot = {
    applicant: { email: owner?.email ?? "", name: owner?.name ?? "", phone: owner?.phone ?? hostel.contact?.phone ?? "" },
    name: hostel.name,
    via: "KYC",
  };

  // The queue reads the newest application per hostel: one row, re-opened on every submit.
  await HostelApplicationModel.findOneAndUpdate(
    { hostelId: id },
    {
      $set: { reviewedAt: null, snapshot, status: "PENDING", submittedBy: userId },
      $setOnInsert: { applicantId: hostel.ownerId, hostelId: id, source: "PUBLIC" },
    },
    { sort: { createdAt: -1 }, upsert: true },
  );
  await HostelVerificationModel.findOneAndUpdate(
    { hostelId: id },
    { $set: { status: "PENDING", updatedBy: userId }, $setOnInsert: { createdBy: userId } },
    { upsert: true },
  );
  await AuditLogModel.create({
    action: "HOSTEL_KYC_SUBMITTED",
    actorId: userId,
    entityId: id.toString(),
    entityType: "Hostel",
    hostelId: id,
  });
  await notifyPlatformOfPendingHostel(hostel, { email: owner?.email, name: owner?.name }).catch(() => {});

  return getHostelKyc(id, userId);
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

  return getHostelKyc(id, userId);
}

/** The uploader takes back their own file; an approved one stays as evidence. */
export async function removeHostelKycDocument(
  hostelId: string | Types.ObjectId,
  userId: string,
  documentId: string,
) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(documentId)) {
    throw new HostelServiceError("Document was not found.", "DOCUMENT_NOT_FOUND", 404);
  }

  const id = new Types.ObjectId(String(hostelId));
  const actor = new Types.ObjectId(userId);
  const removed = await HostelDocumentModel.findOneAndUpdate(
    { _id: new Types.ObjectId(documentId), createdBy: actor, hostelId: id, isDeleted: false, status: { $ne: "APPROVED" } },
    { deletedAt: new Date(), deletedBy: actor, isDeleted: true, updatedBy: actor },
  );

  if (!removed) {
    throw new HostelServiceError("Only your own document can be removed, and only before it is approved.", "DOCUMENT_NOT_REMOVABLE", 404);
  }

  return getHostelKyc(id, userId);
}
