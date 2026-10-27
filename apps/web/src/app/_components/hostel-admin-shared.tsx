"use client";

import { type IconComponent } from "@/components/icons";
import { PageHero } from "@/components/page-hero";
import type { ReactNode } from "react";

export type LoadState = "idle" | "loading" | "ready" | "error";

export type Resident = {
  /** "Bills on the 20th" — from the server (field review E2). */
  billsOn?: string;
  billingCycle?: "CALENDAR_MONTH" | "SAME_DAY";
  /** Their move-out notice (E5), when they gave one. */
  leavingOn?: string | null;
  leavingReason?: string | null;
  /**
   * The login this resident signs in with, or `null` when they have none yet.
   *
   * Not the same thing as `email`. That is the address the hostel recorded — on
   * a scanned intake it comes off the resident's own profile form, which they
   * can edit independently of their account. This is read from the account
   * itself, so it is the address that actually works at the sign-in box.
   */
  account?: {
    email: string;
    /**
     * Their profile picture: the photo they put on their ID card, served from
     * `/api/v1/users/<id>/avatar`, or a sign-in provider's URL. Null when they
     * have neither. It is the same picture the mobile app and their own header
     * draw — a person has one face in this product, not one per screen.
     */
    image: string | null;
    name: string;
  } | null;
  bedId: string;
  demoDataLabel?: string;
  depositAmount: number;
  email?: string;
  firstName: string;
  fullName?: string;
  id: string;
  isDemoData?: boolean;
  lastName: string;
  monthlyFee?: number;
  moveInDate: string;
  phone: string;
  residentType?: "STUDENT" | "WORKING_PROFESSIONAL" | "OTHER";
  /** "204" when the hostel keeps floors and rooms. */
  roomId?: string | null;
  roomNumber?: string | null;
  roomType: string;
  /** A special fee replacing the rate, with why. */
  specialFee?: { amount: number; reason: string } | null;
  status: "PENDING" | "ACTIVE" | "SUSPENDED" | "MOVED_OUT";
};

export type AvailableRoomType = {
  monthlyRent: number;
  roomType: string;
  vacantBeds: number;
};

export type Payment = {
  dueAmount: number;
  dueDate: string;
  id: string;
  month: string;
  paidAmount: number;
  paymentMethod?: string;
  residentId: string;
  status: "UNPAID" | "PAID" | "PARTIAL" | "OVERDUE" | "PENDING_PROOF";
};

/**
 * A payment claim in the review queue.
 *
 * A `PENDING` `PaymentEvent` since item 2.8 — hence `eventId`, `invoiceId` and
 * `evidenceAssetId` in place of the old proof's fields, and `SETTLED` where the
 * screen says "approved". `residentName` comes down with the row so the queue
 * does not need a second request per claim.
 */
/** One server-computed check on a claim (item 3.5). Amber never blocks a review. */
export type ClaimCheck = {
  detail: string;
  key: string;
  ok: boolean;
};

export type PaymentProof = {
  /** True when every check passed — the only rows `Approve all` may touch. */
  allGreen?: boolean;
  amount: number;
  checks?: ClaimCheck[];
  eventId: string;
  evidenceAssetId: string | null;
  /** MIME type of the evidence, so the viewer can render a PDF as a PDF. */
  evidenceMimeType?: string | null;
  invoiceId: string | null;
  method?: string;
  occurredAt?: string;
  period?: string | null;
  referenceNote?: string | null;
  rejectionReason?: string;
  residentId: string;
  residentName?: string;
  reviewFlags?: string[];
  status: "PENDING" | "SETTLED" | "REJECTED";
  transactionCode?: string | null;
};

export type Notice = {
  category: string;
  content: string;
  expiresAt?: string;
  id: string;
  isUrgent: boolean;
  publishedAt?: string;
  title: string;
};

export type Complaint = {
  adminResponse?: string;
  attachments: Array<{ fileAssetId: string; id: string }>;
  category: string;
  confirmedAt?: string;
  createdAt?: string;
  description: string;
  id: string;
  isAnonymous: boolean;
  isOverdue: boolean;
  residentId: string | null;
  slaDueAt: string;
  status: "PENDING" | "IN_PROGRESS" | "RESOLVED" | "REJECTED";
  title: string;
  /**
   * The resident's own recording, when they spoke instead of typing — the app's
   * raise screen offers the microphone first. Absent on every complaint raised
   * from this portal's own form, which has no recorder.
   *
   * `description` can be empty when this is set: for a spoken complaint the
   * recording *is* the description, so a queue row that only prints text shows
   * an empty complaint.
   */
  voiceNoteAssetId?: string;
};

export type ComplaintSummary = {
  inProgress: number;
  overdue: number;
  pending: number;
  rejected: number;
  resolved: number;
  total: number;
};

export function field(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function optionalField(form: FormData, name: string) {
  const value = field(form, name);
  return value.length > 0 ? value : undefined;
}

export function DemoDataBadge({ label }: { label?: string }) {
  return (
    <span
      className="inline-flex w-fit items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-bold uppercase tracking-wide text-amber-700"
      title={label || "Seeded demo/test data"}
    >
      Mock/Test data
    </span>
  );
}

export function PageHeader({
  action,
  description,
  icon: Icon,
  title,
}: {
  action?: ReactNode;
  description: string;
  icon: IconComponent;
  title: string;
}) {
  return <PageHero actions={action} description={description} icon={Icon} title={title} />;
}
