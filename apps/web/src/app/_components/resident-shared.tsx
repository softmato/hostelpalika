"use client";

import { Home } from "@/components/icons";
import { PageHero } from "@/components/page-hero";

export type LoadState = "idle" | "loading" | "ready" | "error";

export type ResidentSummary = {
  depositAmount: number;
  email?: string;
  firstName: string;
  fullName?: string;
  id: string;
  lastName: string;
  phone: string;
  residentType?: "STUDENT" | "WORKING_PROFESSIONAL" | "OTHER";
  status: string;
};

export type ResidentDashboard = {
  /**
   * Residents are placed by room type (the sharing tier they pay for), not by
   * an individual room or bed record — see the note on the Resident model.
   */
  accommodation: {
    roomType: string;
  };
  complaints: {
    openCount: number;
  };
  feeStatus: {
    /** Summed over **every** unsettled invoice, not the last six. */
    dueAmount: number;
    /**
     * The most recent invoice, whatever its state — for "Bhadra 2083 · PAID".
     *
     * **Not the invoice a resident has to act on.** It is `payments[0]` out of a
     * `dueDate: -1` sort with no unpaid filter, so it is the invoice due
     * furthest in the future and may well be settled. Use `nextDue` for a date.
     */
    latestPayment?: Payment | null;
    /**
     * The **earliest unsettled** invoice — the one whose due date belongs beside
     * an outstanding total. `null` when nothing is owed.
     */
    nextDue?: Payment | null;
    pendingProofs: number;
    /** Every unsettled invoice, not the unsettled ones among the last six. */
    unpaidCount: number;
  };
  foodMenu: FoodMenu[];
  hostel: {
    contact?: {
      email?: string;
      phone?: string;
    };
    location?: {
      address?: string;
      area?: string;
      city?: string;
    };
    name: string;
    /** First EXTERIOR photo when there is one, else the first photo at all. */
    photoUrl?: string;
    slug?: string;
  } | null;
  nightStatus: {
    checkedAt: string | null;
    status: string;
  };
  notices: Notice[];
  resident: ResidentSummary;
};

/**
 * An invoice, as the portal reads it.
 *
 * Still called `Payment` and still speaking `UNPAID`: the ledger facade
 * translates on the way out so the screens could keep working while the models
 * changed underneath them (item 2.8). Block 3 renames both together, per screen.
 * `month` is the invoice's `period`.
 */
export type Payment = {
  dueAmount: number;
  dueDate: string;
  id: string;
  /**
   * `YYYY-MM`, or **null** for a one-off that belongs to no month — the joining
   * bill is the one every hostel raises. This mirrors `PortalInvoice.month`,
   * which has always been nullable; declaring it `string` here was the screen
   * asserting something the server never promised, and the first resident with
   * an admission fee took the payments page down with a `localeCompare` of
   * null. Every reader goes through `monthLabel`, which prints the empty case.
   */
  month: string | null;
  paidAmount: number;
  /**
   * Every receipt for this month that has not been voided, newest first.
   *
   * A list rather than one: there is a receipt per settled payment, so a month
   * paid in instalments has several and the resident needs all of them.
   */
  receipts?: {
    amount: number;
    id: string;
    issuedAt: string | null;
    number: string;
  }[];
  /** This month's reference code — what the Resident Offer Program runs on. */
  referenceCode?: string | null;
  status: "UNPAID" | "PAID" | "PARTIAL" | "OVERDUE" | "PENDING_PROOF";
};

/**
 * A payment claim awaiting review — a `PENDING` `PaymentEvent` since item 2.8,
 * which is why it carries `eventId` and `invoiceId` rather than a `paymentId`.
 * `SETTLED` is the ledger's word for what the screens label "approved".
 */
export type PaymentProof = {
  amount: number;
  eventId: string;
  evidenceAssetId: string | null;
  id?: string;
  invoiceId: string | null;
  method?: string;
  referenceNote?: string | null;
  rejectionReason?: string | null;
  status: "PENDING" | "SETTLED" | "REJECTED";
  transactionCode?: string | null;
};

export type FoodMenu = {
  dayOfWeek:
    | "SUNDAY"
    | "MONDAY"
    | "TUESDAY"
    | "WEDNESDAY"
    | "THURSDAY"
    | "FRIDAY"
    | "SATURDAY";
  items: string[];
  mealType: "BREAKFAST" | "LUNCH" | "SNACKS" | "DINNER";
  note: string;
  timing: string;
};

export type FoodRoutine = {
  meals: FoodMenu[];
  monthEndSpecial: { items: string[]; note: string } | null;
};

export type FoodPhoto = {
  caption?: string;
  date: string;
  id: string;
  mealType: string;
  photoAssetId: string;
};

export type Notice = {
  category: string;
  content: string;
  id: string;
  isRead?: boolean;
  isUrgent: boolean;
  publishedAt?: string;
  readAt?: string;
  title: string;
};

export type Complaint = {
  adminResponse?: string;
  attachments: Array<{
    fileAssetId: string;
    id: string;
  }>;
  category: string;
  confirmedAt?: string;
  createdAt?: string;
  description: string;
  id: string;
  isAnonymous: boolean;
  isOverdue: boolean;
  slaDueAt: string;
  status: "PENDING" | "IN_PROGRESS" | "RESOLVED" | "REJECTED";
  title: string;
  /**
   * Their own recording, on a complaint raised from the app by speaking rather
   * than typing. `description` is empty on those, so a row that prints only
   * text shows a complaint with nothing in it.
   */
  voiceNoteAssetId?: string;
};

export function field(form: FormData, name: string) {
  const value = form.get(name);

  return typeof value === "string" ? value.trim() : "";
}

export function optionalField(form: FormData, name: string) {
  const value = field(form, name);

  return value.length > 0 ? value : undefined;
}

export function ResidentHeader({
  description,
  icon: Icon,
  title,
}: {
  description: string;
  icon: typeof Home;
  title: string;
}) {
  return <PageHero description={description} icon={Icon} title={title} />;
}

export function Message({ value }: { value: string }) {
  return value ? (
    <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">{value}</div>
  ) : null;
}
