import { randomBytes } from "node:crypto";

import { Types } from "mongoose";
import { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { afterResponse } from "@/lib/after-response";
import { connectToDatabase } from "@/lib/db";
import { logger } from "@/lib/logger";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { outboundUrl } from "@/lib/site";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { ADMISSION_FORM_NOTIFICATION_TYPE } from "@/modules/notifications/push-routing";
import {
  openDetails,
  type ResidentDetails,
  residentDetailsSchema,
  sealDetails,
} from "@/modules/residents/resident-details";
import {
  admissionDocumentSchema,
  admissionFormPhotoPath,
  applicantPhotoSchema,
  claimAdmissionDocuments,
  claimApplicantPhoto,
  DOCUMENT_LABELS,
  missingDocument,
  saveResidentDocuments,
} from "@/modules/residents/applicant-photo";
import { resolveHostelStaffUserIds } from "@/modules/residents/resident-notify";
import { streamCardPhoto } from "@/modules/users/resident-identity.service";
import { AdmissionFormModel } from "@hostel/db/models/AdmissionForm";
import { AdmissionFormLinkModel } from "@hostel/db/models/AdmissionFormLink";
import { HostelModel } from "@hostel/db/models/Hostel";
import { ResidentModel } from "@hostel/db/models/Resident";

/**
 * The Form QR: a hostel's paper application form, filled by the person on their
 * own phone. Staff show the QR from the scanner screen, the person scans it,
 * fills `/join/apply/{token}` in the app or the browser, and staff get a bell
 * saying somebody wants to live there. From the Residents tab the form opens
 * the normal intake — pick a bed, register — and the intake marks it ADDED.
 */

/** Forms waiting at once; past this a leaked QR cannot flood the queue. */
const MAX_WAITING = 60;

export class AdmissionFormError extends Error {
  constructor(
    message: string,
    public errorCode: string,
    public status = 422,
  ) {
    super(message);
  }
}

export const admissionFormInputSchema = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  phone: z
    .string()
    .trim()
    .min(7)
    .max(24)
    .refine((value) => /^\+?[\d\s().-]+$/.test(value), "Enter a phone number."),
  /** Their login once the hostel registers them — Google on it, or "Forgot password". */
  email: z.string({ error: "Write your email." }).trim().toLowerCase().email("Write your email."),
  residentType: z.enum(["STUDENT", "WORKING_PROFESSIONAL", "OTHER"]).default("STUDENT"),
  details: residentDetailsSchema,
  /** Their face — taken or uploaded on the form. The hostel checks the person against it. */
  photo: applicantPhotoSchema,
  /** Their own ID always; the guardian's when the hostel requires it. */
  documents: z.array(admissionDocumentSchema).max(4).default([]),
  /** "I agree to the rules of the hostel" — the paper form's declaration. */
  agreed: z.literal(true, { error: "Tick that you agree to the hostel's rules." }),
});

export type AdmissionFormInput = z.infer<typeof admissionFormInputSchema>;

type FormDoc = {
  _id: Types.ObjectId;
  decidedAt?: Date | null;
  detailsData?: string | null;
  email: string;
  firstName: string;
  hostelId: Types.ObjectId;
  lastName: string;
  phone: string;
  photoAssetId?: Types.ObjectId | null;
  documents?: { fileAssetId: Types.ObjectId; kind: "APPLICANT_ID" | "GUARDIAN_ID" }[];
  residentId?: Types.ObjectId | null;
  residentType: "OTHER" | "STUDENT" | "WORKING_PROFESSIONAL";
  status: "ADDED" | "DECLINED" | "PENDING";
  submittedAt: Date;
};

export type AdmissionFormView = {
  details: ResidentDetails | null;
  /** Opened in the app's viewer by asset id, through the staff-only file route. */
  documents: { assetId: string; kind: string; label: string }[];
  email: string;
  firstName: string;
  id: string;
  lastName: string;
  phone: string;
  /** The staff photo route for their face, or null. */
  photo: string | null;
  residentId: string | null;
  residentType: FormDoc["residentType"];
  status: FormDoc["status"];
  submittedAt: string;
};

function toView(form: FormDoc): AdmissionFormView {
  return {
    details: openDetails(form.detailsData),
    documents: (form.documents ?? []).map((document) => ({
      assetId: document.fileAssetId.toString(),
      kind: document.kind,
      label: DOCUMENT_LABELS[document.kind],
    })),
    email: form.email,
    firstName: form.firstName,
    id: form._id.toString(),
    lastName: form.lastName,
    phone: form.phone,
    photo: form.photoAssetId ? admissionFormPhotoPath(form._id, form.photoAssetId) : null,
    residentId: form.residentId?.toString() ?? null,
    residentType: form.residentType,
    status: form.status,
    submittedAt: new Date(form.submittedAt).toISOString(),
  };
}

type LinkDoc = { enabled: boolean; guardianDocRequired?: boolean; token: string };

export function admissionFormUrl(token: string) {
  return `${outboundUrl()}/join/apply/${token}`;
}

async function renderQr(text: string) {
  try {
    const { toDataURL } = await import("qrcode");

    return await toDataURL(text, { errorCorrectionLevel: "M", margin: 1, width: 480 });
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Staff                                                                      */
/* -------------------------------------------------------------------------- */

export async function getAdmissionFormLink(hostelId: Types.ObjectId, principal: ApiPrincipal) {
  await connectToDatabase();

  let link = await AdmissionFormLinkModel.findOne({ hostelId }).lean<LinkDoc | null>();

  if (!link) {
    try {
      link = (
        await AdmissionFormLinkModel.create({
          createdBy: principal.userId,
          hostelId,
          // 12 url-safe characters: short enough to read out, far too many to guess.
          token: randomBytes(9).toString("base64url"),
        })
      ).toObject() as LinkDoc;
    } catch (error) {
      // Two staff opening it at once: both get the one link.
      if ((error as { code?: number }).code !== 11000) throw error;

      link = await AdmissionFormLinkModel.findOne({ hostelId }).lean<LinkDoc | null>();
    }
  }

  const url = admissionFormUrl(link!.token);
  const [hostel, qrDataUrl] = await Promise.all([
    HostelModel.findById(hostelId).select("name").lean<{ name?: string } | null>(),
    renderQr(url),
  ]);

  return {
    enabled: link!.enabled,
    guardianDocRequired: Boolean(link!.guardianDocRequired),
    hostelName: hostel?.name ?? "",
    qrDataUrl,
    url,
  };
}

/** Settings → Form details. Wardens and owners alike (`registerResidents`). */
export async function updateAdmissionFormSettings(
  hostelId: Types.ObjectId,
  input: { guardianDocRequired: boolean },
  principal: ApiPrincipal,
) {
  await getAdmissionFormLink(hostelId, principal);
  await AdmissionFormLinkModel.updateOne(
    { hostelId },
    { $set: { guardianDocRequired: input.guardianDocRequired } },
  );

  return getAdmissionFormLink(hostelId, principal);
}

export async function listAdmissionForms(hostelId: Types.ObjectId) {
  await connectToDatabase();

  const forms = await AdmissionFormModel.find({ hostelId, status: "PENDING" })
    .sort({ submittedAt: -1 })
    .limit(MAX_WAITING)
    .lean<FormDoc[]>();

  return { forms: forms.map(toView), waiting: forms.length };
}

async function findForm(hostelId: Types.ObjectId, formId: string) {
  const form = Types.ObjectId.isValid(formId)
    ? await AdmissionFormModel.findOne({ _id: new Types.ObjectId(formId), hostelId }).lean<FormDoc | null>()
    : null;

  if (!form) {
    throw new AdmissionFormError("That form was not found.", "ADMISSION_FORM_NOT_FOUND", 404);
  }

  return form;
}

export async function getAdmissionForm(hostelId: Types.ObjectId, formId: string) {
  await connectToDatabase();

  return toView(await findForm(hostelId, formId));
}

/** Not taking them. The form stays as the record and leaves the list. */
export async function declineAdmissionForm(
  hostelId: Types.ObjectId,
  formId: string,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const form = await findForm(hostelId, formId);

  await AdmissionFormModel.updateOne(
    { _id: form._id, status: "PENDING" },
    { $set: { decidedAt: new Date(), decidedBy: principal.userId, status: "DECLINED" } },
  );

  return { ok: true };
}

/**
 * What the person's own form needs beyond the schema: the rest of what their ID
 * card prints, because registering them makes the card from it (`card-from-form.ts`).
 */
export function cardGap(details: AdmissionFormInput["details"]): string | null {
  if (!details.dateOfBirth) return "Write your date of birth.";
  if (!details.gender) return "Choose your gender.";
  if (!details.family.some((person) => (person.phone ?? "").replace(/\D/g, "").length >= 7)) {
    return "Write your father's or mother's contact number.";
  }
  if (!details.signature) return "Sign the form.";

  return null;
}

/** Who sent the form when they were signed in: registering them links that account. */
export async function admissionFormSubmitter(hostelId: Types.ObjectId, formId: string) {
  if (!Types.ObjectId.isValid(formId)) return null;

  const form = await AdmissionFormModel.findOne({ _id: new Types.ObjectId(formId), hostelId })
    .select("userId")
    .lean<{ userId?: Types.ObjectId | null } | null>();

  return form?.userId ?? null;
}

/** Called by the intake once the resident exists. Never fails the intake. */
export async function markAdmissionFormAdded(
  hostelId: Types.ObjectId,
  formId: string,
  residentId: Types.ObjectId,
  principal: ApiPrincipal,
) {
  if (!Types.ObjectId.isValid(formId)) return;

  const form = await AdmissionFormModel.findOneAndUpdate(
    { _id: new Types.ObjectId(formId), hostelId, status: "PENDING" },
    { $set: { decidedAt: new Date(), decidedBy: principal.userId, residentId, status: "ADDED" } },
  ).lean<FormDoc | null>();

  // Their face goes with them, unless the desk took a new one.
  if (form?.photoAssetId) {
    await ResidentModel.updateOne({ _id: residentId, photoAssetId: null }, { $set: { photoAssetId: form.photoAssetId } });
  }

  if (form?.documents?.length) {
    await saveResidentDocuments(residentId, hostelId, form.documents, principal.userId);
  }
}

/** The photo on a form, streamed — the bucket is private. */
export async function readAdmissionFormPhoto(hostelId: Types.ObjectId, formId: string) {
  await connectToDatabase();

  const form = await findForm(hostelId, formId);

  if (!form.photoAssetId) {
    throw new AdmissionFormError("That form has no photo.", "PHOTO_MISSING", 404);
  }

  return streamCardPhoto(form.photoAssetId, {
    missing: "That photo is no longer available.",
    unavailable: "Could not load that photo right now.",
  });
}

/* -------------------------------------------------------------------------- */
/* The person filling it                                                      */
/* -------------------------------------------------------------------------- */

async function openLink(token: string) {
  const link = await AdmissionFormLinkModel.findOne({ token: token.trim() }).lean<{
    enabled: boolean;
    guardianDocRequired?: boolean;
    hostelId: Types.ObjectId;
  } | null>();
  const hostel = link
    ? await HostelModel.findOne({ _id: link.hostelId, isDeleted: { $ne: true } })
        .select("location.city name")
        .lean<{ location?: { city?: string }; name?: string } | null>()
    : null;

  if (!link || !hostel) {
    throw new AdmissionFormError(
      "This form does not work any more. Ask the hostel for their new QR.",
      "ADMISSION_FORM_LINK_NOT_FOUND",
      404,
    );
  }

  return { hostel: { city: hostel.location?.city ?? "", name: hostel.name ?? "" }, link };
}

export async function getAdmissionFormPage(token: string) {
  await connectToDatabase();

  const { hostel, link } = await openLink(token);

  return { guardianDocRequired: Boolean(link.guardianDocRequired), hostel, open: link.enabled };
}

export async function submitAdmissionForm(
  token: string,
  input: AdmissionFormInput,
  userId: string | null,
) {
  await connectToDatabase();

  const { hostel, link } = await openLink(token);

  if (!link.enabled) {
    throw new AdmissionFormError("This hostel is not taking forms right now.", "ADMISSION_FORM_OFF", 409);
  }

  const gap = cardGap(input.details);

  if (gap) {
    throw new AdmissionFormError(gap, "ADMISSION_FORM_INCOMPLETE");
  }

  const missing = missingDocument(
    input.documents.map((document) => document.kind),
    Boolean(link.guardianDocRequired),
  );

  if (missing) {
    throw new AdmissionFormError(missing, "ADMISSION_FORM_DOCUMENT_MISSING");
  }

  // Before anything is written, so a bad photo or scan never leaves a half-sent form.
  const photoAssetId = await claimApplicantPhoto(input.photo, link.hostelId);
  const documents = await claimAdmissionDocuments(input.documents, link.hostelId);

  const fields = {
    detailsData: sealDetails(input.details),
    documents,
    photoAssetId,
    email: input.email,
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone,
    residentType: input.residentType,
    submittedAt: new Date(),
    ...(userId ? { userId: new Types.ObjectId(userId) } : {}),
  };

  // The same phone sending again replaces its own waiting form, and staff are not told twice.
  const replaced = await AdmissionFormModel.findOneAndUpdate(
    { hostelId: link.hostelId, phone: input.phone, status: "PENDING" },
    { $set: fields },
  );

  if (!replaced) {
    const waiting = await AdmissionFormModel.countDocuments({ hostelId: link.hostelId, status: "PENDING" });

    if (waiting >= MAX_WAITING) {
      throw new AdmissionFormError(
        "This hostel has too many forms waiting. Ask them at the desk.",
        "ADMISSION_FORM_FULL",
        409,
      );
    }

    await AdmissionFormModel.create({ ...fields, hostelId: link.hostelId });
    afterResponse(() => tellStaff(link.hostelId, `${input.firstName} ${input.lastName}`.trim()));
  }

  // Not a signed-in staff write, so `announceWrite` never sees it: an open Residents tab is told here.
  afterResponse(() =>
    publishResourceChange({ hostelIds: [link.hostelId.toString()], topics: [REALTIME_TOPIC.RESIDENTS] }),
  );

  return { hostelName: hostel.name, sent: true };
}

async function tellStaff(hostelId: Types.ObjectId, name: string) {
  try {
    const staff = await resolveHostelStaffUserIds(hostelId);

    await Promise.all(
      staff.map((userId) =>
        createInAppNotification({
          actionUrl: "/hostel-admin/residents",
          body: "Filled your admission form · choose a bed to register them",
          category: "RESIDENT",
          data: { type: ADMISSION_FORM_NOTIFICATION_TYPE },
          hostelId: hostelId.toString(),
          title: `${name} wants to live in your hostel`,
          userId,
        }),
      ),
    );
  } catch (error) {
    logger.warn("Admission form: staff were not told", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
