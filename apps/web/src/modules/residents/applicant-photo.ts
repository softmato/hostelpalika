import { Types } from "mongoose";
import { z } from "zod";

import { isValidDocumentClaimToken } from "@/lib/registration-documents";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { ResidentDocumentModel } from "@hostel/db/models/ResidentDocument";

/**
 * The applicant's photo on the admission form.
 *
 * The person filling the Form QR has no account, so the photo goes up the way
 * registration documents do: the anonymous private upload
 * (`POST /public/files/upload`, `visibility=private`) answers with the asset id
 * and an HMAC claim token, and the form names both. The warden's no-card form
 * uses the same door, so there is one check for both. Claiming ties the file to
 * the hostel; the bytes stay in the private bucket and are only ever streamed
 * back through the staff photo routes.
 */
export const applicantPhotoSchema = z.object({
  claimToken: z.string().trim().min(10).max(200),
  fileAssetId: z.string().regex(/^[a-f\d]{24}$/i, "That photo could not be read."),
});

export type ApplicantPhoto = z.infer<typeof applicantPhotoSchema>;

const PHOTO_TYPES = ["image/jpeg", "image/png", "image/webp"];

export class ApplicantPhotoError extends Error {
  errorCode = "APPLICANT_PHOTO_INVALID";
  status = 422;
}

export function claimApplicantPhoto(photo: ApplicantPhoto, hostelId: Types.ObjectId) {
  return claimUpload(photo, hostelId, PHOTO_TYPES, "photo");
}

async function claimUpload(
  photo: ApplicantPhoto,
  hostelId: Types.ObjectId,
  types: string[],
  what: string,
) {
  if (!isValidDocumentClaimToken(photo.fileAssetId, photo.claimToken)) {
    throw new ApplicantPhotoError(`That ${what} could not be checked. Add it again.`);
  }

  const asset = await FileAssetModel.findOneAndUpdate(
    {
      _id: new Types.ObjectId(photo.fileAssetId),
      $or: [{ hostelId: { $exists: false } }, { hostelId: null }, { hostelId }],
      accessLevel: "PRIVATE",
      isDeleted: false,
      kind: "REGISTRATION_DOCUMENT",
      mimeType: { $in: types },
      status: "ACTIVE",
    },
    { $set: { hostelId } },
    { new: true },
  )
    .select("_id")
    .lean<{ _id: Types.ObjectId } | null>();

  if (!asset) {
    throw new ApplicantPhotoError(`That ${what} is no longer available. Add it again.`);
  }

  return asset._id;
}

/*
 * The documents on the form. The applicant's own ID is always asked; the
 * guardian's is optional until the hostel turns on "Guardian's ID document —
 * required" (`AdmissionFormLink.guardianDocRequired`, Settings → Form details).
 */
export const ADMISSION_DOCUMENT_KINDS = ["APPLICANT_ID", "GUARDIAN_ID"] as const;

export type AdmissionDocumentKind = (typeof ADMISSION_DOCUMENT_KINDS)[number];

export const DOCUMENT_LABELS: Record<AdmissionDocumentKind, string> = {
  APPLICANT_ID: "Citizenship or ID",
  GUARDIAN_ID: "Guardian's citizenship or ID",
};

export const admissionDocumentSchema = applicantPhotoSchema.extend({
  kind: z.enum(ADMISSION_DOCUMENT_KINDS),
});

export type AdmissionDocument = z.infer<typeof admissionDocumentSchema>;

/** What is missing, in words for the person filling the form, or null. */
export function missingDocument(kinds: readonly string[], guardianRequired: boolean) {
  if (!kinds.includes("APPLICANT_ID")) return "Add a photo of your citizenship or ID.";
  if (guardianRequired && !kinds.includes("GUARDIAN_ID")) {
    return "This hostel needs your guardian's citizenship or ID too.";
  }

  return null;
}

/** Each document tied to the hostel, one per kind; a scan may be a PDF. */
export async function claimAdmissionDocuments(documents: AdmissionDocument[], hostelId: Types.ObjectId) {
  const byKind = new Map(documents.map((document) => [document.kind, document]));

  return Promise.all(
    [...byKind.values()].map(async (document) => ({
      fileAssetId: await claimUpload(document, hostelId, [...PHOTO_TYPES, "application/pdf"], "document"),
      kind: document.kind,
    })),
  );
}

/** Kept on the resident as `ResidentDocument` rows, the hostel's file on them. */
export async function saveResidentDocuments(
  residentId: Types.ObjectId,
  hostelId: Types.ObjectId,
  documents: { fileAssetId: Types.ObjectId; kind: string }[],
  uploadedBy: string,
) {
  if (documents.length === 0) return;

  await ResidentDocumentModel.insertMany(
    documents.map((document) => ({
      documentType: document.kind,
      fileAssetId: document.fileAssetId,
      hostelId,
      residentId,
      uploadedBy: new Types.ObjectId(uploadedBy),
    })),
  );
}

export async function listResidentDocuments(residentId: Types.ObjectId) {
  const rows = await ResidentDocumentModel.find({ residentId })
    .sort({ uploadedAt: 1 })
    .lean<{ _id: Types.ObjectId; documentType: string; fileAssetId: Types.ObjectId }[]>();

  return rows.map((row) => ({
    assetId: row.fileAssetId.toString(),
    id: row._id.toString(),
    kind: row.documentType,
    label: DOCUMENT_LABELS[row.documentType as AdmissionDocumentKind] ?? row.documentType,
  }));
}

/** What the staff app draws as the face; `v` busts the cache when the photo changes. */
export function residentPhotoPath(residentId: Types.ObjectId | string, assetId: Types.ObjectId | string) {
  return `/api/v1/hostel-admin/residents/${residentId}/photo?v=${assetId}`;
}

export function admissionFormPhotoPath(formId: Types.ObjectId | string, assetId: Types.ObjectId | string) {
  return `/api/v1/hostel-admin/residents/admission-forms/${formId}/photo?v=${assetId}`;
}
