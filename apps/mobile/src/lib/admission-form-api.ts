import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import type { ResidentDetails } from "@/lib/resident-details";

/**
 * The Form QR (`apps/web/src/modules/residents/admission-form.service.ts`):
 * somebody who wants to live here fills the hostel's admission form on their
 * own phone, and staff register them from the Residents tab.
 */

/** A citizenship / ID scan on file, opened in the viewer by `assetId`. */
export type AdmissionDocumentView = { assetId: string; kind: string; label: string };

export type AdmissionForm = {
  details: ResidentDetails | null;
  documents?: AdmissionDocumentView[];
  email: string;
  firstName: string;
  id: string;
  lastName: string;
  phone: string;
  /** The staff route for their face — draw it with `PersonAvatar`. */
  photo: string | null;
  residentId: string | null;
  residentType: "OTHER" | "STUDENT" | "WORKING_PROFESSIONAL";
  status: "ADDED" | "DECLINED" | "PENDING";
  submittedAt: string;
};

export type AdmissionForms = { forms: AdmissionForm[]; waiting: number };

export type AdmissionFormLink = {
  enabled: boolean;
  /** Settings → Form details: the guardian's ID document is required. Off = optional. */
  guardianDocRequired?: boolean;
  hostelName: string;
  qrDataUrl: string | null;
  url: string;
};

export type AdmissionFormPage = {
  guardianDocRequired?: boolean;
  hostel: { city: string; name: string };
  open: boolean;
};

export type AdmissionFormInput = {
  agreed: true;
  details: ResidentDetails;
  email?: string;
  firstName: string;
  lastName: string;
  phone: string;
  photo: { claimToken: string; fileAssetId: string };
  documents: { claimToken: string; fileAssetId: string; kind: "APPLICANT_ID" | "GUARDIAN_ID" }[];
  residentType: AdmissionForm["residentType"];
};

/* Hostel staff */

export async function getAdmissionFormLink() {
  return unwrap(await api.get<ApiEnvelope<AdmissionFormLink>>("/hostel-admin/residents/admission-form-link"));
}

export async function updateAdmissionFormSettings(patch: { guardianDocRequired: boolean }) {
  return unwrap(
    await api.patch<ApiEnvelope<AdmissionFormLink>>("/hostel-admin/residents/admission-form-link", patch),
  );
}

export async function listAdmissionForms() {
  return unwrap(await api.get<ApiEnvelope<AdmissionForms>>("/hostel-admin/residents/admission-forms"));
}

export async function getAdmissionForm(id: string) {
  return unwrap(
    await api.get<ApiEnvelope<AdmissionForm>>(`/hostel-admin/residents/admission-forms/${encodeURIComponent(id)}`),
  );
}

export async function declineAdmissionForm(id: string) {
  return unwrap(
    await api.delete<ApiEnvelope<{ ok: true }>>(`/hostel-admin/residents/admission-forms/${encodeURIComponent(id)}`),
  );
}

/* The person filling it — no account needed */

export async function getAdmissionFormPage(token: string) {
  return unwrap(
    await api.get<ApiEnvelope<AdmissionFormPage>>(`/public/admission-form/${encodeURIComponent(token)}`),
  );
}

export async function sendAdmissionForm(token: string, input: AdmissionFormInput) {
  return unwrap(
    await api.post<ApiEnvelope<{ hostelName: string; sent: true }>>(
      `/public/admission-form/${encodeURIComponent(token)}`,
      input,
    ),
  );
}
