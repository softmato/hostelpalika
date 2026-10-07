"use client";

import { type LucideIcon } from "lucide-react";

export type LoadState = "idle" | "loading" | "ready" | "error";

export type Resident = {
  firstName: string;
  id: string;
  lastName: string;
  phone: string;
  status: string;
};

export type NightStatusRow = {
  resident: Resident;
  status: {
    checkedAt: string | null;
    note?: string;
    status: string;
  };
};

export type SOSAlert = {
  createdAt?: string;
  guardianAlertEnabled: boolean;
  id: string;
  message: string;
  residentId: string;
  status: "ACTIVE" | "ACKNOWLEDGED" | "RESOLVED" | "FALSE_ALARM";
};

/**
 * What a guardian may be shown, field by field. Every flag defaults to false on
 * the server — sharing is opt-in (PRD.md §10).
 *
 * These matter to the UI, not just to the query: each section of the dashboard
 * is fetched **only** when its flag is set, so an ungranted section arrives as
 * an empty array. Without the flags, "your ward has no complaints" and "you are
 * not allowed to see complaints" are the same payload — so a section whose flag
 * is off must be *absent*, never drawn empty.
 */
export type GuardianPermissions = {
  canViewComplaintStatus: boolean;
  canViewFood: boolean;
  canViewNotices: boolean;
  canViewPayments: boolean;
  canViewReceipts: boolean;
  canViewSafety: boolean;
};

/**
 * Mirrors `getGuardianDashboard`'s return in
 * `apps/web/src/modules/guardian/guardian.service.ts`. Read it there before
 * changing anything here — this type had drifted from the serializer three ways
 * at once, and every one of them rendered as broken text on the page:
 * `firstName`/`lastName` (the serializer returns **`fullName`**) printed
 * "undefined undefined"; `safety.checkedAt` (it returns **`asOf`**, a date, on
 * purpose) printed "Invalid Date"; and a non-null `summary` (it returns
 * **null** without `canViewPayments`) threw outright.
 */
export type GuardianDashboard = {
  access: { expiresAt: string; status: string };
  complaints: Array<{ id: string; status: string; title: string }>;
  food: Array<{ id: string; items: string[]; mealType: string; timing: string }>;
  guardian: { id: string; name: string; phone: string; relation: string };
  hostel: {
    contact: { email: string; phone: string };
    id: string;
    /** The platform's own verdict. The dashboard used to badge every hostel
     * "Verified" whether it was or not. */
    isVerified: boolean;
    location?: { address?: string; area?: string; city?: string };
    name: string;
    /** Cover photo — EXTERIOR first, else any photo, else "". */
    photoUrl: string;
    /** Empty unless /hostels/{slug} is actually live for this hostel, so the
     * link is never drawn onto a 404. */
    slug: string;
  } | null;
  notices: Array<{
    category: string;
    content: string;
    id: string;
    isUrgent: boolean;
    title: string;
  }>;
  payments: Array<{
    dueAmount: number;
    dueDate?: string;
    id: string;
    month: string;
    paidAmount: number;
    status: string;
  }>;
  permissions: GuardianPermissions;
  receipts: Array<{
    amount: number;
    id: string;
    issuedOn: string;
    month: string;
    receiptNumber: string;
  }>;
  resident: {
    fullName: string;
    id: string;
    /** Their profile picture — the photo on their ID card, or null. */
    image: string | null;
    roomType: string;
    status: string;
  };
  /** `asOf` is a **date** (`YYYY-MM-DD`), truncated deliberately: the exact time
   * a resident was checked is the surveillance detail PHASES.md §4.1 forbids
   * showing a guardian. Null when `canViewSafety` is false. */
  safety: { asOf: string | null; status: string } | null;
  /** Null when `canViewPayments` is false. */
  summary: { dueAmount: number; unpaidCount: number } | null;
};

export type Review = {
  comment: string;
  id: string;
  overallRating: number;
  status: "VISIBLE" | "HIDDEN";
};

export type Notification = {
  body: string;
  id: string;
  isRead: boolean;
  title: string;
};

export function PageHeader({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: LucideIcon;
  title: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <span className="rounded-lg bg-muted p-3 text-foreground">
        <Icon className="size-5" />
      </span>
      <div>
        <h1 className="font-heading text-3xl font-bold text-foreground">{title}</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  );
}

export function field(form: FormData, name: string) {
  const value = form.get(name);

  return typeof value === "string" ? value.trim() : "";
}

export function optionalNumber(form: FormData, name: string) {
  const value = Number(field(form, name));

  return Number.isFinite(value) ? value : 0;
}

export function Message({ value }: { value: string }) {
  return value ? (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">{value}</div>
  ) : null;
}
