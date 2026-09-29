import { API_BASE_URL, api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";

/**
 * Residents already living in the hostel when it joined
 * (docs/EXISTING_RESIDENTS.md). Mirrors
 * `apps/web/src/modules/residents/existing-residents.service.ts` — read that
 * service, not this file, when the two disagree.
 */

const BASE = "/hostel-admin/residents/existing";

export type ExistingRow = {
  depositPaid: number;
  email: string;
  fullName: string;
  id: string;
  joinedDate: string | null;
  monthlyRent: number | null;
  oldDues: number;
  paidTill: string | null;
  phone: string;
  residentId: string | null;
  roomType: string;
};

export type ExistingRowField =
  | "email"
  | "fullName"
  | "joinedDate"
  | "monthlyRent"
  | "paidTill"
  | "phone"
  | "roomType";

export type ExistingCheckedRow = {
  added: boolean;
  bills: {
    months: { amount: number; label: string; period: string }[];
    oldDues: number;
    total: number;
  } | null;
  id: string;
  problems: { field: ExistingRowField; message: string }[];
  rent: number | null;
};

export type ExistingCheck = {
  listProblems: string[];
  ready: boolean;
  roomTypes: { freeBeds: number; inList: number; roomType: string }[];
  rows: ExistingCheckedRow[];
  toAdd: number;
  withProblems: number;
};

export type ExistingAddResult = {
  added: number;
  billsRaised: number;
  problems: { message: string; name: string }[];
};

export type ExistingResidentsView = {
  check: ExistingCheck | null;
  currentMonth: { label: string; period: string };
  hostel: { id: string; name: string };
  lastAdded: (ExistingAddResult & { addedAt: string }) | null;
  list: { id: string; rows: ExistingRow[]; updatedAt: string | null } | null;
  roomTypes: { freeBeds: number; monthlyRent: number | null; roomType: string }[];
};

/** A row as the screen sends it: no `residentId`, and no `id` until the server gave one. */
export type ExistingRowInput = Omit<ExistingRow, "id" | "residentId"> & { id?: string };

export async function getExistingResidents() {
  return unwrap(await api.get<ApiEnvelope<ExistingResidentsView>>(BASE));
}

export async function saveExistingResidents(rows: ExistingRowInput[]) {
  return unwrap(await api.put<ApiEnvelope<ExistingResidentsView>>(BASE, { rows }));
}

export async function uploadExistingResidentsFile(input: {
  contentBase64: string;
  fileName: string;
}) {
  return unwrap(
    await api.post<ApiEnvelope<{ notes: string[]; read: number; view: ExistingResidentsView }>>(
      `${BASE}/file`,
      input,
    ),
  );
}

export async function addExistingResidents() {
  return unwrap(
    await api.post<ApiEnvelope<{ result: ExistingAddResult; view: ExistingResidentsView }>>(
      `${BASE}/add`,
    ),
  );
}

export async function clearExistingResidents() {
  return unwrap(await api.delete<ApiEnvelope<ExistingResidentsView>>(BASE));
}

export function existingResidentsTemplateUrl() {
  return `${API_BASE_URL}/api/v1${BASE}/template`;
}

/** One scanned person who already lived here, added off the intake's bed step. */
export async function addScannedExistingResident(
  input: Omit<ExistingRowInput, "id" | "monthlyRent"> & { userResidentId?: string },
) {
  return unwrap(
    await api.post<ApiEnvelope<{ residentId: string | null; result: ExistingAddResult }>>(
      `${BASE}/one`,
      input,
    ),
  );
}
