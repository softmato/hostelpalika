import type { BillPreview } from "@/lib/residents/existing-residents.types";

export type ResidencyInvite = {
  firstName: string;
  hostelName: string;
  /** Rupees due right now across open bills. Zero means all clear. */
  dueAmount: number;
  /** `Aswin 2083` when the hostel recorded one, for "all clear till". */
  paidTill: string | null;
  residentId: string;
  roomType: string;
};

export type JoinLinkView = {
  cap: number;
  enabled: boolean;
  qrDataUrl: string | null;
  url: string;
  used: number;
  /** Requests waiting for a staff answer. */
  waiting: number;
};

export type JoinRequestView = {
  bills: BillPreview | null;
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
  /** What would stop Add right now, in the check's own words. */
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

export type JoinPageView = {
  currentMonth: { label: string; period: string };
  hostel: { city: string; name: string };
  /** OPEN takes new requests; FULL and OFF only let an existing one be fixed. */
  link: "FULL" | "OFF" | "OPEN";
  /** Their own request here, when they are signed in and have one. */
  request: JoinRequestView | null;
  roomTypes: { monthlyRent: number | null; roomType: string }[];
  token: string;
  /** Null when signed out. */
  viewer: {
    /** READY can send; the rest say what to do first. */
    card: "NONE" | "PRIVATE" | "READY";
    cardId: string | null;
    email: string;
    fullName: string;
    hasPhoto: boolean;
    /** Where they live already, when that stops them sending. */
    livesAt: { hostelName: string; sameHostel: boolean } | null;
    phone: string;
    photoUpdatedAt: string | null;
  } | null;
};
