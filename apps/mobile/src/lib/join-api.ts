import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";

/**
 * The join link (docs/EXISTING_RESIDENTS.md, "Join link"). Mirrors
 * `apps/web/src/modules/residents/resident-join.service.ts` — read that service,
 * not this file, when the two disagree.
 */

export type JoinBills = {
  months: { amount: number; label: string; period: string }[];
  oldDues: number;
  partPaid: number;
  total: number;
};

export type JoinRequest = {
  bills: JoinBills | null;
  cardId: string;
  decidedAt: string | null;
  depositPaid: number;
  email: string;
  fullName: string;
  id: string;
  joinedDate: string | null;
  note: string;
  paidTill: string;
  partPaid: number;
  phone: string;
  problems: string[];
  rejectReason: string;
  rent: number | null;
  rentLabel: string;
  residentId: string | null;
  roomType: string;
  sends: number;
  sentAt: string;
  status: "ADDED" | "PENDING" | "REJECTED";
};

export type JoinLink = {
  cap: number;
  enabled: boolean;
  qrDataUrl: string | null;
  url: string;
  used: number;
  waiting: number;
};

export type JoinRequests = {
  currentMonth: { label: string; period: string };
  requests: JoinRequest[];
  waiting: number;
};

export type JoinPage = {
  currentMonth: { label: string; period: string };
  hostel: { city: string; name: string };
  link: "FULL" | "OFF" | "OPEN";
  request: JoinRequest | null;
  roomTypes: { monthlyRent: number | null; roomType: string }[];
  token: string;
  viewer: {
    card: "NONE" | "PRIVATE" | "READY";
    cardId: string | null;
    email: string;
    fullName: string;
    hasPhoto: boolean;
    livesAt: { hostelName: string; sameHostel: boolean } | null;
    phone: string;
    photoUpdatedAt: string | null;
  } | null;
};

export type JoinRequestInput = {
  depositPaid: number;
  joinedDate: string | null;
  note: string;
  paidTill: string;
  partPaid: number;
  roomType: string;
};

/* Hostel staff */

export async function getJoinLink() {
  return unwrap(await api.get<ApiEnvelope<JoinLink>>("/hostel-admin/residents/join-link"));
}

export async function updateJoinLink(patch: { cap?: number; enabled?: boolean; renew?: true }) {
  return unwrap(await api.patch<ApiEnvelope<JoinLink>>("/hostel-admin/residents/join-link", patch));
}

export async function listJoinRequests() {
  return unwrap(await api.get<ApiEnvelope<JoinRequests>>("/hostel-admin/residents/join-requests"));
}

export async function addJoinRequest(id: string) {
  return unwrap(
    await api.post<ApiEnvelope<{ residentId: string | null }>>(
      `/hostel-admin/residents/join-requests/${id}`,
      { action: "add" },
    ),
  );
}

export async function sendBackJoinRequest(id: string, reason: string) {
  return unwrap(
    await api.post<ApiEnvelope<{ ok: true }>>(`/hostel-admin/residents/join-requests/${id}`, {
      action: "reject",
      reason,
    }),
  );
}

/* The person opening the link */

/** Their own request still open — waiting, or sent back — and the link it came from. */
export type MyJoinRequest = {
  request: {
    hostelName: string;
    reason: string;
    status: "PENDING" | "REJECTED";
    token: string;
  } | null;
};

export async function getMyJoinRequest() {
  return unwrap(await api.get<ApiEnvelope<MyJoinRequest>>("/public/join-requests/me"));
}

export async function getJoinPage(token: string) {
  return unwrap(await api.get<ApiEnvelope<JoinPage>>(`/public/join/${encodeURIComponent(token)}`));
}

export async function sendJoinRequest(token: string, input: JoinRequestInput) {
  return unwrap(
    await api.post<ApiEnvelope<JoinPage>>(`/public/join/${encodeURIComponent(token)}`, input),
  );
}
