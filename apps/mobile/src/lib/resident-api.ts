/**
 * The resident surface outside finance — dashboard, food, notices, night status.
 *
 * Finance lives in `lib/finance-api.ts`; the split follows the server's own,
 * where `/resident/finance/*` is a separate module with its own ledger facade.
 *
 * Shapes mirror the serializers in `apps/web/src/modules/*`. There is no shared
 * package between the two yet, so this file is the seam: if a serializer
 * changes there, it changes here.
 *
 * ## `nightStatus` and `complaints` are real now
 *
 * They used to be hardcoded literals on the server — `{ status: "UNKNOWN" }`,
 * which is not a value the enum contains, and `{ openCount: 0, recent: [] }` —
 * so Home made a second request to `/resident/night-status` and did not render
 * complaints at all. `resident-dashboard.service.ts` reads both properly as of
 * 2026-08-17, and `nightStatus` now carries the same `serializeNightStatus`
 * shape the dedicated endpoint returns (absent means `NOT_VERIFIED`, never
 * `UNKNOWN`). `getResidentNightStatus()` stays for the screen that *sets* it.
 */

import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import type { MealType, RoutineDay } from "@/lib/food-week";
import type { NightStatusReasonCode } from "@/lib/night-status-actions";
import type { NightHistoryEntry } from "@/lib/night-status-history";
import type { SosAlert } from "@/lib/safety-api";

/* -------------------------------------------------------------------------- */
/* Shared                                                                     */
/* -------------------------------------------------------------------------- */

export type ResidentSummary = {
  depositAmount: number;
  email: string;
  firstName: string;
  fullName: string;
  hostelId: string;
  id: string;
  lastName: string;
  moveInDate: string;
  phone: string;
  residentType: "OTHER" | "STUDENT" | "WORKING_PROFESSIONAL";
  roomType: string;
  status: "ACTIVE" | "MOVED_OUT" | "PENDING" | "SUSPENDED";
};

export type ResidentHostel = {
  contact: { email?: string; phone?: string };
  id: string;
  location: { address?: string; area?: string; city?: string };
  name: string;
  photoUrl: string;
  slug: string;
};

/*
 * Re-exported, not defined here. The enums live in `lib/food-week.ts` because
 * this module imports the axios client and therefore React Native, which makes
 * it unloadable from a node-side Vitest file — and the day arithmetic that
 * needs those constants is exactly what has to be tested.
 */
export {
  MEAL_TYPES,
  type MealType,
  ROUTINE_DAYS,
  type RoutineDay,
} from "@/lib/food-week";

export type RoutineMeal = {
  dayOfWeek: RoutineDay;
  items: string[];
  mealType: MealType;
  note: string;
  timing: string;
};

export type FoodRoutine = {
  meals: RoutineMeal[];
  monthEndSpecial: { items: string[]; note: string } | null;
  timings: Partial<Record<MealType, string>>;
  updatedAt: string;
};

export type ResidentNotice = {
  category: string;
  content: string;
  createdAt?: string;
  expiresAt?: string;
  id: string;
  isRead: boolean;
  isUrgent: boolean;
  publishedAt?: string;
  readAt?: string;
  targetAudience: string;
  title: string;
};

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

export type DashboardInvoice = {
  dueAmount: number;
  dueDate?: string;
  id: string;
  month: string;
  paidAmount: number;
  status: string;
};

/** The dashboard's cut of a complaint: enough for a row, no thread, no files. */
export type DashboardComplaint = {
  category: string;
  createdAt?: string;
  id: string;
  /** Past its SLA and still open. The reason the row is worth showing at all. */
  isOverdue: boolean;
  status: string;
  title: string;
};

export type ResidentDashboard = {
  accommodation: { roomType: string };
  complaints: { openCount: number; recent: DashboardComplaint[] };
  feeStatus: {
    /** Summed over **every** unsettled invoice, not the last six. */
    dueAmount: number;
    /**
     * The most recent invoice, whatever its state — for "Bhadra 2083 · PAID".
     *
     * **Not the invoice a resident has to act on**, and reading it as one is the
     * bug this field's sibling exists to fix. It is `payments[0]` out of a
     * `dueDate: -1` sort with no unpaid filter, so it is the invoice due
     * furthest in the future and may well be settled. Use `nextDue` for a date.
     */
    latestPayment: DashboardInvoice | null;
    /**
     * The **earliest unsettled** invoice — the one whose due date is worth
     * showing beside an outstanding total. `null` when nothing is owed.
     */
    nextDue: DashboardInvoice | null;
    pendingProofs: number;
    /** Every unsettled invoice, not the unsettled ones among the last six. */
    unpaidCount: number;
  };
  /** Today's meals, already filtered to the current weekday by the server. */
  foodMenu: RoutineMeal[];
  hostel: ResidentHostel | null;
  /** Same `serializeNightStatus` shape the dedicated endpoint returns. */
  nightStatus: NightStatus;
  notices: Pick<
    ResidentNotice,
    "category" | "content" | "id" | "isRead" | "isUrgent" | "publishedAt" | "title"
  >[];
  resident: ResidentSummary;
  /**
   * The resident's most recent SOS alert, or `null` if they have never raised
   * one. `readLatestSOSFor` on the server.
   *
   * **Not the same fact as `nightStatus.status === "SOS_TRIGGERED"`**, which is
   * what every screen used to read. The night status is one upserted row per
   * resident with no expiry, so that value sticks until the resident sets a new
   * status; the alert row is what says whether staff have settled it and when it
   * was raised. `lib/sos.ts` owns both rules.
   */
  sos: SosAlert | null;
};

/** `GET /resident/profile` — the dashboard's resident block plus their people. */
export type ResidentProfile = {
  accommodation: { roomType: string };
  emergencyContacts: {
    id: string;
    isPrimary: boolean;
    name: string;
    phone: string;
    relation: string;
  }[];
  guardians: {
    email: string;
    firstName: string;
    id: string;
    isPrimary: boolean;
    lastName: string;
    phone: string;
    relation: string;
  }[];
  hostel: ResidentHostel | null;
  resident: ResidentSummary;
};

export async function getResidentProfile() {
  const response = await api.get<ApiEnvelope<{ profile: ResidentProfile }>>(
    "/resident/profile",
  );

  return unwrap(response).profile;
}

export async function getResidentDashboard() {
  const response = await api.get<ApiEnvelope<{ dashboard: ResidentDashboard }>>(
    "/resident/dashboard",
  );

  return unwrap(response).dashboard;
}

/* -------------------------------------------------------------------------- */
/* Night status                                                               */
/* -------------------------------------------------------------------------- */

export const NIGHT_STATUSES = [
  "INSIDE_HOSTEL",
  "OUTSIDE_HOSTEL",
  "NOT_VERIFIED",
  "MARKED_SAFE",
  "SOS_TRIGGERED",
] as const;

export type NightStatusValue = (typeof NIGHT_STATUSES)[number];

export type NightStatus = {
  checkedAt: string | null;
  id?: string;
  /**
   * Whether this answer is about **tonight**.
   *
   * The row is upserted and never cleared, so `status` on its own is the last
   * answer ever given rather than the current one. The server now stamps the
   * night and reports a stale row as `NOT_VERIFIED`; this says which of the two
   * happened, so a screen can show "last set on Tuesday" without implying
   * Tuesday's answer still stands.
   */
  isCurrentNight?: boolean;
  /** `YYYY-MM-DD`, the 17:00-to-17:00 night this answer was about. */
  night?: string | null;
  note: string;
  /** The preset they tapped, when they tapped one instead of typing. */
  reasonCode?: NightStatusReasonCode | null;
  source: string;
  /** `NOT_VERIFIED` when the resident has no row yet — an answer, not an absence. */
  status: NightStatusValue | string;
};

/**
 * What `GET /resident/night-status` returns: the row, and the alert that has to
 * be read beside it.
 *
 * The endpoint used to return the status alone, so the screen decided whether an
 * SOS was live from `status === "SOS_TRIGGERED"` — a value nothing ever clears.
 */
export type NightStatusView = {
  sos: SosAlert | null;
  status: NightStatus;
};

export async function getResidentNightStatus(): Promise<NightStatusView> {
  const response = await api.get<ApiEnvelope<NightStatusView>>(
    "/resident/night-status",
  );

  const payload = unwrap(response);

  return { sos: payload.sos ?? null, status: payload.status };
}

export async function setResidentNightStatus(input: {
  note?: string;
  reasonCode?: NightStatusReasonCode;
  /**
   * Which surface the answer came from. `APP` here; the notification's own
   * buttons send `PUSH_ACTION` from `night-status-notification.ts`. It decides
   * nothing on the server — it is the one number that says whether residents
   * are actually answering from the shade, which is the whole bet of this
   * feature.
   */
  source?: "APP" | "PUSH_ACTION" | "WEB";
  status: NightStatusValue;
}) {
  const response = await api.post<ApiEnvelope<{ status: NightStatus }>>(
    "/resident/night-status",
    input,
  );

  return unwrap(response).status;
}

/**
 * `GET /resident/night-status/history` — one entry per night, newest first,
 * from the first recorded night up to tonight (at most 60).
 */
export async function getResidentNightStatusHistory(): Promise<NightHistoryEntry[]> {
  const response = await api.get<ApiEnvelope<{ nights: NightHistoryEntry[] }>>(
    "/resident/night-status/history",
  );

  return unwrap(response).nights ?? [];
}

/* -------------------------------------------------------------------------- */
/* Food                                                                       */
/* -------------------------------------------------------------------------- */

export type FoodPhoto = {
  caption: string;
  date: string;
  id: string;
  mealType: MealType;
  photoAssetId: string;
  uploadedAt: string;
};

export type ResidentFood = {
  photos: FoodPhoto[];
  resident: ResidentSummary;
  routine: FoodRoutine;
};

export async function getResidentFood() {
  const response = await api.get<ApiEnvelope<ResidentFood>>("/resident/food");

  return unwrap(response);
}

/**
 * `date` and `mealType` together are what the rating is *about*, so both are
 * required — a rating with no meal attached cannot be aggregated by the admin's
 * food analytics and is indistinguishable from noise.
 */
export async function submitFoodFeedback(input: {
  comment?: string;
  /** ISO string; the server coerces it to a date. */
  date: string;
  isAnonymous?: boolean;
  mealType: MealType;
  rating: number;
}) {
  const response = await api.post<ApiEnvelope<unknown>>("/resident/food/feedback", input);

  return unwrap(response);
}

/** `photoAssetId` comes from the upload pipeline — the server verifies it. */
export async function uploadFoodPhoto(input: {
  caption?: string;
  date: string;
  mealType: MealType;
  photoAssetId: string;
}) {
  const response = await api.post<ApiEnvelope<unknown>>("/resident/food/photos", input);

  return unwrap(response);
}

/* -------------------------------------------------------------------------- */
/* Notices                                                                    */
/* -------------------------------------------------------------------------- */

export type ResidentNoticeList = {
  notices: ResidentNotice[];
  pagination: {
    hasMore: boolean;
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  resident: ResidentSummary;
};

export async function getResidentNotices(page = 1) {
  const response = await api.get<ApiEnvelope<ResidentNoticeList>>("/resident/notices", {
    params: { page },
  });

  return unwrap(response);
}

/**
 * PATCH, not POST — the server upserts the read row with `$setOnInsert`, so
 * marking an already-read notice read again is a no-op rather than a second
 * timestamp.
 */
export async function markNoticeRead(noticeId: string) {
  const response = await api.patch<ApiEnvelope<unknown>>(
    `/resident/notices/${noticeId}/read`,
  );

  return unwrap(response);
}

/* -------------------------------------------------------------------------- */
/* QuestionCall                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Records a tap on the QuestionCall row. Where it goes is site config, opened
 * by `lib/questioncall.ts` in the tap itself — this only feeds the platform's
 * click analytics, so a failure here must never stop the resident getting there.
 *
 * The server validates `deviceType` as `"android" | "ios" | "web"`.
 */
export async function recordQuestionCallClick(deviceType: "android" | "ios" | "web") {
  const response = await api.post<ApiEnvelope<{ clickId: string; ssoCode: string | null }>>(
    "/resident/questioncall/click",
    { deviceType },
  );

  return unwrap(response);
}
