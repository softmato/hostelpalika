/**
 * The half of hostel admin that used to be a browser hand-off.
 *
 * `admin-api.ts` opens with a paragraph explaining that the app is "deliberately
 * reduced" and that fee schedules, room configuration and warden management are
 * a desktop's job. That argument was overruled on 2026-08-21 (tasks.md §12): the
 * app owes the web **feature parity**, and a row that opens `WebBrowser` is not
 * an app screen. This module is the API surface those screens needed, kept apart
 * from `admin-api.ts` only because that file is already long — nothing here is a
 * different *kind* of call.
 *
 * ## Two rules carried over from `admin-api.ts`, because they still hold
 *
 * 1. **Shapes are read off the services**, never off the portal's hand-written
 *    types. The web components routinely declare a narrower type than the
 *    serializer returns — `serializePost` returning `media` that the moderation
 *    panel's type drops is the case §11.1 hit — so a field missing from a web
 *    page is not evidence the server does not send it.
 * 2. **A 403 is not a bug.** Every route below runs through
 *    `requireHostelCapability` with a *named* flag (`editHostelProfile`,
 *    `manageNotices`, `manageFood`, `manageMaintenance`, `registerResidents`,
 *    `manageFinance`, `viewReports`, `manageWardens`), so a warden can be
 *    allowed one screen and refused its neighbour. Screens load their sources
 *    independently and say "not yours" rather than rendering empty.
 */

import { api } from "@/lib/api";
import type { AdminSubscription } from "@/lib/admin-api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import type { PayMethod } from "@/lib/finance-api";
import type { MealType, RoutineDay } from "@/lib/food-week";
import type { LocationMatch } from "@/lib/registration-api";

/* -------------------------------------------------------------------------- */
/* Hostel profile — Rooms and Settings both read it                           */
/* -------------------------------------------------------------------------- */

/** One row of `roomConfigurations`. Rooms are counts per type, not records. */
export type RoomConfiguration = {
  bedsPerRoom: number;
  /** `Included` | `Not Included` | `Optional` — the server enum, verbatim. */
  mealInclusion: string;
  monthlyRent?: number;
  rooms: number;
  roomType: string;
  vacantBeds: number;
};

export type HostelPhoto = {
  alt: string;
  fileAssetId?: string;
  id?: string;
  /** `EXTERIOR` | `INTERIOR` | `ROOM`. */
  kind: string;
  /** Set on ROOM photos only — which room type the shot belongs to. */
  roomType: string;
  url: string;
};

/**
 * `serializeHostel` in full, as opposed to `AdminHostel` in `admin-api.ts`,
 * which is deliberately the subset Home draws.
 *
 * Both come from `GET /hostel-admin/profile`. Keeping two types for one payload
 * is the lesser evil: Home would otherwise carry twenty fields it never reads,
 * and the editing screens genuinely need all of them.
 */
export type ManagedHostel = {
  capacitySummary: {
    totalBeds?: number;
    totalRooms?: number;
    vacantBeds?: number;
  };
  contact: { email?: string; phone?: string };
  description: string;
  facilities: string[];
  food: {
    hasNonVeg?: boolean;
    hasVeg?: boolean;
    mealsPerDay?: number;
    notes?: string;
  };
  hostelType: string;
  id: string;
  location: {
    address?: string;
    area?: string;
    city?: string;
    lat?: number;
    lng?: number;
    locationSource?: string;
    province?: string;
  };
  name: string;
  /**
   * How many times the hostel has renamed itself since approval. The limit is
   * server-side and a rename past it is a 403 with `NAME_CHANGE_LIMIT_REACHED`,
   * not a validation error — which is why Settings shows the count rather than
   * letting someone find out by typing.
   */
  nameChangeCount: number;
  /** Written once; a correction goes through a superadmin (`hostel-profile.service`). */
  panNumber?: string | null;
  photos: HostelPhoto[];
  pricing: {
    admissionFee?: number;
    formFee?: number;
    currency?: string;
    monthlyRentMax?: number;
    monthlyRentMin?: number;
  };
  roomConfigurations: RoomConfiguration[];
  roomTypes: string[];
  rules: string[];
  /** "Find the gate": a short note and one photo of the entrance, or null. */
  arrivalGuide?: { note: string; photoUrl: string } | null;
  slug: string;
  status: string;
  totalFloors: number;
  verificationStatus: string;
};

export async function getManagedHostel() {
  const response = await api.get<ApiEnvelope<{ hostel: ManagedHostel }>>(
    "/hostel-admin/profile",
  );

  return unwrap(response).hostel;
}

/**
 * `PATCH /hostel-admin/profile`. Every key is optional and only what is sent is
 * written, so a screen patches its own fields and never has to round-trip the
 * ones it does not show.
 *
 * **`roomConfigurations` is all-or-nothing.** The service replaces the array
 * wholesale, recomputes `capacitySummary` from it, and drops any ROOM photo
 * whose room type is no longer in the list. Sending one edited row would delete
 * every other room type and its photographs, so the Rooms screen always sends
 * the whole array.
 */
export async function updateManagedHostel(input: {
  arrivalGuide?: { note?: string; photoUrl?: string };
  capacitySummary?: {
    totalBeds?: number;
    totalRooms?: number;
    vacantBeds?: number;
  };
  contact?: { email?: string; phone?: string };
  description?: string;
  facilities?: string[];
  food?: {
    hasNonVeg?: boolean;
    hasVeg?: boolean;
    mealsPerDay?: number;
    notes?: string;
  };
  hostelType?: string;
  location?: {
    address?: string;
    area?: string;
    city?: string;
    lat?: number;
    lng?: number;
    /**
     * "MANUAL" when the owner picked the pin. Hostel KYC only counts a MANUAL
     * pin, and the re-geocode after save keeps a MANUAL pin where it is.
     */
    locationSource?: "GEOCODED" | "MANUAL";
    province?: string;
  };
  name?: string;
  /** Written once — the server ignores it when the hostel already has one. */
  panNumber?: string;
  pricing?: {
    admissionFee?: number;
    formFee?: number;
    currency?: string;
    monthlyRentMax?: number;
    monthlyRentMin?: number;
  };
  roomConfigurations?: RoomConfiguration[];
  rules?: string[];
  totalFloors?: number;
}) {
  const response = await api.patch<ApiEnvelope<{ hostel: ManagedHostel }>>(
    "/hostel-admin/profile",
    input,
  );

  return unwrap(response).hostel;
}

/**
 * `POST /hostel-admin/profile/photos`.
 *
 * `url` is stored **relative** — `/api/v1/files/{assetId}/url` — exactly as the
 * web sends it, so the same record resolves against whichever origin is reading
 * it. Run it through `absoluteMediaUrl` before it reaches an `<Image>`.
 *
 * The asset itself must be uploaded `PUBLIC`: these photographs are the public
 * listing's gallery, read by visitors who have no session at all.
 */
export async function addHostelPhoto(input: {
  alt?: string;
  fileAssetId: string;
  kind: "EXTERIOR" | "INTERIOR" | "ROOM";
  roomType?: string;
}) {
  await api.post("/hostel-admin/profile/photos", {
    ...input,
    url: `/api/v1/files/${input.fileAssetId}/url`,
  });
}

export async function deleteHostelPhoto(photoId: string) {
  await api.delete(`/hostel-admin/profile/photos/${photoId}`);
}

/* -------------------------------------------------------------------------- */
/* Notices                                                                    */
/* -------------------------------------------------------------------------- */

export const NOTICE_CATEGORIES = [
  "GENERAL",
  "URGENT",
  "EVENT",
  "RULE",
  "MAINTENANCE",
  "PAYMENT",
  "FOOD",
] as const;

export type NoticeCategory = (typeof NOTICE_CATEGORIES)[number];

export const NOTICE_AUDIENCES = ["ALL", "RESIDENTS", "GUARDIANS"] as const;

export type NoticeAudience = (typeof NOTICE_AUDIENCES)[number];

export type ManagedNotice = {
  category: string;
  content: string;
  createdAt?: string;
  expiresAt?: string;
  id: string;
  isUrgent: boolean;
  publishedAt?: string;
  targetAudience: string;
  title: string;
  updatedAt?: string;
};

/**
 * `GET /hostel-admin/notices`.
 *
 * `admin-api.ts` has `listAdminNotices()`, which asks for ten and takes no
 * filter — that is Today's "what did we tell people lately" strip. This one is
 * the management list: a category filter and a real page size.
 */
export async function listManagedNotices(
  query: { category?: string; pageSize?: number } = {},
) {
  const response = await api.get<ApiEnvelope<{ notices: ManagedNotice[] }>>(
    "/hostel-admin/notices",
    {
      params: {
        category: query.category || undefined,
        pageSize: query.pageSize ?? 50,
      },
    },
  );

  return unwrap(response).notices;
}

export type NoticeInput = {
  category: NoticeCategory;
  content: string;
  /** ISO. Omitted means "never expires". */
  expiresAt?: string;
  isUrgent: boolean;
  /** ISO. In the future means the notice is scheduled, not live. */
  publishedAt?: string;
  targetAudience: NoticeAudience;
  title: string;
};

export async function createManagedNotice(input: NoticeInput) {
  await api.post("/hostel-admin/notices", input);
}

/**
 * `PATCH /hostel-admin/notices/{id}` — partial, so this is also how a notice is
 * expired: send `expiresAt` in the past. There is no DELETE route, and that is
 * deliberate on the server's side — a notice residents have already read should
 * stop applying, not stop having existed.
 */
export async function updateManagedNotice(
  id: string,
  input: Partial<NoticeInput>,
) {
  await api.patch(`/hostel-admin/notices/${id}`, input);
}

/* -------------------------------------------------------------------------- */
/* Push notices                                                               */
/* -------------------------------------------------------------------------- */

export type NoticePushRepeat = "NOW" | "LATER" | "DAILY" | "WEEKLY";

export type NoticePushStatus = "ACTIVE" | "PAUSED" | "DONE";

/** `GET /hostel-admin/notice-pushes` — dates are Nepal `YYYY-MM-DD`, times `HH:mm`. */
export type NoticePush = {
  body: string;
  createdAt: string | null;
  id: string;
  /** Created by the platform (the clothes washing reminder). */
  isDefault: boolean;
  isUrgent: boolean;
  lastRunAt: string | null;
  nextRunAt: string | null;
  repeat: NoticePushRepeat;
  runCount: number;
  startsOn: string | null;
  status: NoticePushStatus;
  time: string | null;
  title: string;
  weekdays: number[];
};

/** Timing fields are sent only when they changed; `repeat` included. */
export type NoticePushInput = {
  active?: boolean;
  body?: string;
  date?: string;
  delayMinutes?: number;
  isUrgent?: boolean;
  repeat?: NoticePushRepeat;
  time?: string;
  title?: string;
  weekdays?: number[];
};

export async function listNoticePushes() {
  const response = await api.get<ApiEnvelope<{ pushes: NoticePush[] }>>(
    "/hostel-admin/notice-pushes",
  );

  return unwrap(response).pushes;
}

export async function createNoticePush(input: NoticePushInput) {
  await api.post("/hostel-admin/notice-pushes", input);
}

export async function updateNoticePush(id: string, input: NoticePushInput) {
  await api.patch(`/hostel-admin/notice-pushes/${id}`, input);
}

/** Stops it going out; notices it already put on the board stay. */
export async function deleteNoticePush(id: string) {
  await api.delete(`/hostel-admin/notice-pushes/${id}`);
}

/** Sends it now; its schedule is left alone. */
export async function sendNoticePushNow(id: string) {
  await api.post(`/hostel-admin/notice-pushes/${id}/send`);
}

/* -------------------------------------------------------------------------- */
/* Food routine                                                               */
/* -------------------------------------------------------------------------- */

/**
 * `PUT /hostel-admin/food/routine` — **one document, one replace.**
 *
 * There are no per-cell writes: the payload is the whole week, so the editor
 * holds a draft and saves it in full. A meal with no items is simply absent
 * from `meals` rather than sent empty (the server rejects an empty `items`).
 *
 * `timings` is per meal type, not per day — "Breakfast is at 7:30" is a fact
 * about the hostel, and the resident's Food tab reads it off the same record.
 */
export async function saveFoodRoutine(input: {
  meals: {
    dayOfWeek: RoutineDay;
    items: string[];
    mealType: MealType;
    note?: string;
  }[];
  monthEndSpecial?: { items: string[]; note?: string };
  timings: Partial<Record<MealType, string>>;
}) {
  await api.put("/hostel-admin/food/routine", input);
}

/* -------------------------------------------------------------------------- */
/* Maintenance                                                                */
/* -------------------------------------------------------------------------- */

export const MAINTENANCE_CATEGORIES = [
  "PLUMBING",
  "ELECTRICAL",
  "INTERNET",
  "CLEANING",
  "CARPENTRY",
  "PAINTING",
  "WATER",
  "APPLIANCE",
  "ROOM_REPAIR",
  "HEALTH",
  "OTHER",
] as const;

export type MaintenanceCategory = (typeof MAINTENANCE_CATEGORIES)[number];

export const MAINTENANCE_STATUSES = [
  "PENDING",
  "CONTACTED",
  "SCHEDULED",
  "COMPLETED",
  "CANCELLED",
] as const;

export type MaintenanceStatus = (typeof MAINTENANCE_STATUSES)[number];

export const MAINTENANCE_PRIORITIES = [
  "LOW",
  "MEDIUM",
  "HIGH",
  "URGENT",
] as const;

export type MaintenancePriority = (typeof MAINTENANCE_PRIORITIES)[number];

export type MaintenanceComment = {
  authorId: string;
  createdAt?: string;
  id: string;
  message: string;
  /** `INTERNAL` never reaches the provider; `PROVIDER_NOTE` is meant for them. */
  visibility: string;
};

export type MaintenanceHistoryEntry = {
  action: string;
  costNote: string;
  createdAt?: string;
  id: string;
  nextStatus?: string;
  note: string;
  previousStatus?: string;
};

/**
 * The full request, as opposed to `AdminMaintenanceRequest` in `admin-api.ts`
 * — which is the row Today draws and stops at nine fields.
 *
 * The list route already returns `comments` and `history` per request, so the
 * detail sheet needs no second call. That is worth knowing before adding one.
 */
export type ManagedMaintenanceRequest = {
  category: string;
  comments: MaintenanceComment[];
  completedAt?: string;
  costNote: string;
  createdAt?: string;
  description: string;
  history: MaintenanceHistoryEntry[];
  id: string;
  location: string;
  priority: string;
  providerId?: string;
  remarks: string;
  requestedBy: string;
  scheduledFor?: string;
  status: string;
  title: string;
  updatedAt?: string;
  /**
   * A spoken description of the problem, recorded when the job was raised.
   *
   * A **PRIVATE** asset: play it through `viewerSourceFor`, which puts the
   * bearer token on the request — a bare URL renders a dead player. Absent for
   * every request raised without one, which is most of them.
   */
  voiceNoteAssetId?: string;
};

export type ManagedMaintenance = {
  requests: ManagedMaintenanceRequest[];
  summary: {
    cancelled: number;
    completed: number;
    open: number;
    total: number;
  };
};

export async function listManagedMaintenance(
  query: { category?: string; providerId?: string; status?: string } = {},
) {
  const response = await api.get<ApiEnvelope<ManagedMaintenance>>(
    "/hostel-admin/maintenance/requests",
    {
      params: {
        category: query.category || undefined,
        providerId: query.providerId || undefined,
        status: query.status || undefined,
      },
    },
  );

  return unwrap(response);
}

export async function createMaintenanceRequest(input: {
  category: MaintenanceCategory;
  description?: string;
  location?: string;
  priority: MaintenancePriority;
  providerId?: string;
  scheduledFor?: string;
  title: string;
  /**
   * A completed `MAINTENANCE_NOTE` asset, uploaded just before this call.
   *
   * Attached at creation and never afterwards: the server has no route that
   * adds one to an existing request, deliberately — swapping the recording that
   * describes a job after a contractor has been sent to it is not an edit.
   */
  voiceNoteAssetId?: string;
}) {
  await api.post("/hostel-admin/maintenance/requests", input);
}

/**
 * `PATCH /hostel-admin/maintenance/requests/{id}/status`.
 *
 * `note` and `costNote` ride along with the status change rather than being a
 * separate write, and the service records both on the history entry — so "why
 * was this cancelled" has an answer without reading the comment thread.
 */
export async function updateMaintenanceStatus(
  id: string,
  input: {
    costNote?: string;
    note?: string;
    scheduledFor?: string;
    status: MaintenanceStatus;
  },
) {
  await api.patch(`/hostel-admin/maintenance/requests/${id}/status`, input);
}

/**
 * What a call-out of each trade costs before anybody turns up —
 * `GET /hostel-admin/maintenance/settings`.
 *
 * All eleven trades, always. Read-only: the figures are the platform's, set by
 * the superadmin, and there is no hostel write route — a hostel that could edit
 * them could approve any job by first lowering its charge.
 */
export type MaintenanceCharge = {
  amount: number;
  category: MaintenanceCategory;
};

export async function getMaintenanceSettings() {
  const response = await api.get<
    ApiEnvelope<{ hostelId: string; minimumCharges: MaintenanceCharge[] }>
  >("/hostel-admin/maintenance/settings");

  return unwrap(response).minimumCharges;
}

/**
 * Sending a raised request to a contractor —
 * `PATCH /hostel-admin/maintenance/requests/{id}/provider`.
 *
 * **Once.** The server refuses a request that already has somebody on it with a
 * 409, because re-pointing a live job has a wasted trip on the other end of it;
 * changing who is coming is still cancel-and-raise. That is also why this is not
 * folded into the status update — assigning is not a status change, and a status
 * move must not be able to re-point the job as a side effect.
 *
 * This is what makes the voice note reach anybody: an unassigned request appears
 * in no provider's job list, so nothing plays the recording.
 */
export async function assignMaintenanceProvider(
  id: string,
  providerId: string,
) {
  await api.patch(`/hostel-admin/maintenance/requests/${id}/provider`, {
    providerId,
  });
}

export async function commentOnMaintenance(
  id: string,
  input: { message: string; visibility: "INTERNAL" | "PROVIDER_NOTE" },
) {
  await api.post(`/hostel-admin/maintenance/requests/${id}/comment`, input);
}

/* -------------------------------------------------------------------------- */
/* Service providers                                                          */
/* -------------------------------------------------------------------------- */

/**
 * An approved provider, with the phone number.
 *
 * That number is the reason this route is hostel-admin-only: the public
 * directory serializer drops it on purpose (PHASES.md §5.1), so a provider is
 * not cold-called by everyone who browses the site.
 */
export type ManagedProvider = {
  area: string;
  availability: string;
  categories: string[];
  category: string;
  city: string;
  description: string;
  email: string;
  experience: string;
  fullName: string;
  id: string;
  phone: string;
  photoAssetId?: string;
  ratingSummary: { averageRating: number; totalReviews: number };
};

export async function listManagedProviders(
  query: { category?: string; q?: string } = {},
) {
  const response = await api.get<ApiEnvelope<{ providers: ManagedProvider[] }>>(
    "/hostel-admin/service-providers",
    {
      params: {
        category: query.category || undefined,
        pageSize: 50,
        q: query.q || undefined,
      },
    },
  );

  return unwrap(response).providers;
}

/* -------------------------------------------------------------------------- */
/* Cook portal                                                                */
/* -------------------------------------------------------------------------- */

/**
 * `serializeSettings` in `cook.service` — the cook's *login*, never a password.
 *
 * `initialPasswordPending` is true only while the emailed hand-off password is
 * still unused. After the cook sets their own, nothing but its bcrypt hash
 * exists: the hostel admin cannot read it back, and "recovery" means issuing a
 * new credential. The screen has to say that, because the obvious assumption —
 * that whoever created the account can look the password up — is wrong here.
 */
export type CookPortalSettings = {
  cookEmail: string;
  cookName: string;
  cookPortalEnabled: boolean;
  cookUserId?: string;
  credentialIssuedAt?: string;
  initialPasswordPending: boolean;
};

export async function getCookPortal() {
  const response = await api.get<ApiEnvelope<{ settings: CookPortalSettings }>>(
    "/hostel-admin/cook-portal",
  );

  return unwrap(response).settings;
}

/**
 * `PATCH /hostel-admin/cook-portal`.
 *
 * Enabling creates or reactivates the cook's user account and emails it a
 * one-time password; disabling **suspends** that account rather than deleting
 * it, so the same login comes back if the portal is switched on again.
 */
export async function updateCookPortal(input: {
  cookName?: string;
  enabled: boolean;
}) {
  const response = await api.patch<
    ApiEnvelope<{ settings: CookPortalSettings }>
  >("/hostel-admin/cook-portal", input);

  return unwrap(response).settings;
}

/* -------------------------------------------------------------------------- */
/* Cook roster                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One cook, as `serializeCook` in `cook-roster.service` sends it.
 *
 * Never a password and never an invitation token — `initialPasswordPending`
 * and `invitationPending` are the only things the server will say about either.
 * A cook who has chosen their own password leaves nothing but a bcrypt hash
 * behind, so the screen's answer to "what is the password" is a rotation, not
 * a lookup.
 */
export type CookAccount = {
  acceptedAt?: string;
  addedAt?: string;
  credentialIssuedAt?: string;
  /** `Previous Sunrise cook` — what their past work is filed under once removed. */
  historicalName?: string;
  id: string;
  initialPasswordPending: boolean;
  invitationExpiresAt?: string;
  invitationPending: boolean;
  kind: "CREDENTIAL" | "INVITE";
  loginEmail: string;
  name: string;
  removedAt?: string;
  status: "INVITED" | "ACTIVE" | "REMOVED";
  userId?: string;
};

/** The plaintext password, returned by the one call that ever creates it. */
export type CookCredentials = { email: string; temporaryPassword: string };

export async function getCookRoster() {
  const response = await api.get<
    ApiEnvelope<{
      cooks: CookAccount[];
      expensesEnabled?: boolean;
      fingerprintLock?: boolean;
      portalEnabled: boolean;
    }>
  >("/hostel-admin/cooks");

  return unwrap(response);
}

/** Owner only: ask every cook to lock the app with a fingerprint (`lib/app-lock.ts`). */
export async function setCookFingerprintLock(enabled: boolean) {
  const response = await api.put<ApiEnvelope<{ fingerprintLock: boolean }>>(
    "/hostel-admin/cooks/fingerprint",
    { enabled },
  );

  return unwrap(response);
}

/**
 * `POST /hostel-admin/cooks`.
 *
 * Two shapes, one endpoint. `CREDENTIAL` mints a short login and comes back
 * with its first-time password **once** — there is no second call that can
 * fetch it — so a caller that drops the response has lost it. `INVITE` mails
 * the address and returns no secret at all.
 */
export async function addCook(
  input:
    | { kind: "CREDENTIAL"; name: string }
    | { email: string; kind: "INVITE"; name: string },
) {
  const response = await api.post<
    ApiEnvelope<{ cook: CookAccount; credentials?: CookCredentials }>
  >("/hostel-admin/cooks", input);

  return unwrap(response);
}

/** Rename a cook, or issue a fresh first-time password with `rotate: true`. */
export async function updateCook(
  cookId: string,
  input: { name?: string; rotate?: boolean },
) {
  const response = await api.patch<
    ApiEnvelope<{ cook: CookAccount; credentials?: CookCredentials }>
  >(`/hostel-admin/cooks/${cookId}`, input);

  return unwrap(response);
}

/**
 * `DELETE /hostel-admin/cooks/{id}` — removes a cook for good.
 *
 * The account goes; the row does not. It comes back with `status: "REMOVED"`
 * and the `historicalName` everything they already announced or photographed is
 * attributed to from here on.
 */
export async function removeCook(cookId: string) {
  const response = await api.delete<ApiEnvelope<{ cook: CookAccount }>>(
    `/hostel-admin/cooks/${cookId}`,
  );

  return unwrap(response).cook;
}

/* -------------------------------------------------------------------------- */
/* Reports                                                                    */
/* -------------------------------------------------------------------------- */

/** `{ PENDING: 4, PAID: 12 }` — the shape every status breakdown uses. */
export type CountMap = Record<string, number>;

/**
 * `GET /hostel-admin/reports/attendance`.
 *
 * Built from **zone rows only** — a ping's coordinates are discarded the moment
 * it lands, which is the privacy invariant `location-tracking` tests enforce. So
 * this can say a resident was outside on eleven nights and can never say where.
 */
export type AttendanceAnalytics = {
  frequentlyAbsent: {
    attendanceRate: number;
    name: string;
    outside: number;
    residentId: string;
    roomType: string;
    total: number;
    unknown: number;
  }[];
  summary: {
    averageAttendanceRate: number;
    pings: number;
    residentsTracked: number;
    windowDays: number;
    zones: { inside: number; nearby: number; outside: number; unknown: number };
  };
};

export async function getAttendanceAnalytics(days?: number) {
  const response = await api.get<ApiEnvelope<AttendanceAnalytics>>(
    "/hostel-admin/reports/attendance",
    { params: { days } },
  );

  return unwrap(response);
}

/**
 * `GET /hostel-admin/reports/food` — how late the kitchen actually is.
 *
 * Times are **minutes since midnight**, not clock strings, and delays are signed:
 * negative means the meal went out early.
 */
export type FoodAnalytics = {
  byDevice: {
    announcements: number;
    device: string;
    lastAnnouncedAt: string;
  }[];
  byMeal: {
    announcements: number;
    averageDelayMinutes: number | null;
    averageReadyMinutes: number | null;
    lateCount: number;
    mealType: string;
    notified: number;
    onTimeCount: number;
    scheduledTiming: string | null;
  }[];
  summary: {
    averageDelayMinutes: number | null;
    lateAnnouncements: number;
    onTimeAnnouncements: number;
    totalAnnouncements: number;
    windowDays: number;
  };
};

export async function getFoodAnalytics(days?: number) {
  const response = await api.get<ApiEnvelope<FoodAnalytics>>(
    "/hostel-admin/reports/food",
    {
      params: { days },
    },
  );

  return unwrap(response);
}

/** The four CSVs the portal offers. Aggregates — no phone numbers, no addresses. */
export const REPORT_EXPORTS = [
  { label: "Residents", report: "residents" },
  { label: "Collection", report: "payments" },
  { label: "Complaints", report: "complaints" },
  { label: "Occupancy", report: "occupancy" },
] as const;

export type ReportExport = (typeof REPORT_EXPORTS)[number]["report"];

/** A figure beside the same figure last month. `change` is a percent; `null` when last month was 0. */
export type MonthCompare = {
  change: number | null;
  current: number;
  previous: number;
};

/**
 * `GET /hostel-admin/reports/performance` — the hostel's month on one page.
 *
 * The Reports screen and the downloadable PDF (`reports/performance/pdf`) are
 * the same payload, so what the owner reads is what they download. Dated
 * figures are inside `period.month`; `residents.now`, `residents.tonight` and
 * `beds` are as they stand at `generatedAt`. Mirrors
 * `apps/web/src/modules/reports/performance-report.service.ts`.
 */
export type PerformanceReport = {
  beds: {
    occupancyRate: number | null;
    occupied: number;
    total: number;
    vacant: number;
  };
  finance: {
    billed: number;
    collected: number;
    /** `null` when nothing was billed. */
    collectionRate: number | null;
    methods: { count: number; method: string }[];
    outstanding: number;
    outstandingAllTime: number;
    pendingProofs: number;
    previous: {
      billed: number;
      collected: number;
      collectionRate: number | null;
    };
    /** Six BS months ending at `period.month`, oldest first. */
    trend: {
      billed: number;
      collected: number;
      collectionRate: number | null;
      month: string;
    }[];
  };
  generatedAt: string;
  hostelName: string;
  listing: {
    appearances: MonthCompare;
    inquiries: MonthCompare;
    inquiriesConverted: number;
    rating: { average: number | null; newThisMonth: number; total: number };
    views: MonthCompare;
    visitors: MonthCompare;
  };
  operations: {
    complaints: {
      open: number;
      pastSla: number;
      raised: number;
      resolved: number;
    };
    repairs: { completed: number; open: number; raised: number };
  };
  period: {
    end: string;
    isCurrent: boolean;
    month: string;
    /** Newest first. */
    months: string[];
    previousMonth: string;
    start: string;
  };
  residents: {
    movedIn: number;
    movedOut: number;
    now: { active: number; pending: number; suspended: number; total: number };
    tonight: {
      inside: number;
      night: string;
      notAnswered: number;
      outside: number;
    };
  };
};

export async function getPerformanceReport(month?: string) {
  const response = await api.get<ApiEnvelope<{ report: PerformanceReport }>>(
    "/hostel-admin/reports/performance",
    { params: { month: month || undefined } },
  );

  return unwrap(response).report;
}

/** Where `downloadToDevice` fetches the PDF from. Relative to `API_BASE_URL`. */
export function performanceReportPdfPath(month: string) {
  return `/api/v1/hostel-admin/reports/performance/pdf?month=${encodeURIComponent(month)}`;
}

/** The bank-style statement PDF — credits and debits between two BS months, inclusive. */
/**
 * Every branch in one PDF: a cover comparing the branches (collection, dues,
 * spending, staff cash), then each branch's own pages. Owner only.
 */
export function overallPdfPath(kind: "report" | "statement", month: string) {
  return `/api/v1/hostel-admin/reports/overall/pdf?kind=${kind}&month=${encodeURIComponent(month)}`;
}

export function statementPdfPath(from: string, to: string) {
  return `/api/v1/hostel-admin/reports/statement/pdf?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
}

/* -------------------------------------------------------------------------- */
/* Wardens                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The per-member capability list, verbatim from `warden.validation.ts`.
 *
 * **Order matters here** — it is the order the permission sheet renders, and it
 * is grouped by what the capability lets someone *do to the hostel*, not
 * alphabetically. The three payment powers in the middle were split out of a
 * single `verifyPayments` flag precisely because granting them together let a
 * new warden rewrite any payment amount on their first day.
 */
export const WARDEN_PERMISSIONS = [
  "registerResidents",
  "editHostelProfile",
  "manageRooms",
  "viewPayments",
  "approvePayments",
  "recordCash",
  "reversePayments",
  "manageFeeSchedule",
  "managePaymentProfile",
  "manageFood",
  "manageNotices",
  "viewComplaints",
  "updateComplaints",
  "viewNightStatus",
  "updateNightStatus",
  "manageMaintenance",
  "recordExpenses",
  "manageStock",
  "approveStockCount",
] as const;

export type WardenPermission = (typeof WARDEN_PERMISSIONS)[number];

/**
 * Stored like a permission, shown as its opposite: the warden form's
 * "Bill photo needed" switch is on while this key is absent. Kept out of
 * {@link WARDEN_PERMISSIONS} so the sheet and the "N of M" count never list it
 * as a power — it is the one key that waives a rule rather than granting one.
 */
export const PROOF_WAIVER = "expenseWithoutProof";

/** What a new warden gets — mirrors the server's `DEFAULT_WARDEN_PERMISSIONS`. */
export const DEFAULT_WARDEN_PERMISSIONS: WardenPermission[] = [
  "registerResidents",
  "viewPayments",
  "approvePayments",
  "recordCash",
  "manageFood",
  "manageNotices",
  "viewComplaints",
  "updateComplaints",
  "viewNightStatus",
  "updateNightStatus",
  "manageMaintenance",
  "recordExpenses",
  "manageStock",
];

export type ManagedWarden = {
  createdAt?: string;
  email: string;
  id: string;
  name: string;
  /**
   * May contain `verifyPayments`, a **retired** key still stored on rows the
   * migration has not reached. It is accepted on input for one release and has
   * to round-trip rather than being silently dropped by an edit form.
   */
  permissions: string[];
  phone: string;
  status: string;
  userId: string;
};

/** Admin-only: every warden route is `requireHostelAdminPrincipal`, not staff. */
export async function listWardens() {
  const response = await api.get<ApiEnvelope<{ wardens: ManagedWarden[] }>>(
    "/hostel-admin/wardens",
    { params: { pageSize: 50 } },
  );

  return unwrap(response).wardens;
}

/**
 * `POST /hostel-admin/wardens`.
 *
 * The account is created INVITED and the person signs in with the credentials
 * the server emails them. An address that already has an account is *linked* to
 * this hostel rather than rejected, which is how one person wardens two
 * buildings.
 */
export async function createWarden(input: {
  email: string;
  name: string;
  permissions?: WardenPermission[];
  phone?: string;
}) {
  await api.post("/hostel-admin/wardens", input);
}

export async function updateWarden(
  id: string,
  input: { permissions?: string[]; status?: "ACTIVE" | "SUSPENDED" },
) {
  await api.patch(`/hostel-admin/wardens/${id}`, input);
}

/** Deactivates the membership. The user account itself survives. */
export async function removeWarden(id: string) {
  await api.delete(`/hostel-admin/wardens/${id}`);
}

/* -------------------------------------------------------------------------- */
/* Hostel-level switches                                                      */
/* -------------------------------------------------------------------------- */

export type CommunitySettings = {
  enabled: boolean;
  profanityFilterEnabled: boolean;
};

export async function getCommunitySettings() {
  const response = await api.get<ApiEnvelope<{ settings: CommunitySettings }>>(
    "/hostel-admin/settings/community",
  );

  return unwrap(response).settings;
}

export async function updateCommunitySettings(
  input: Partial<CommunitySettings>,
) {
  const response = await api.patch<
    ApiEnvelope<{ settings: CommunitySettings }>
  >("/hostel-admin/settings/community", input);

  return unwrap(response).settings;
}

/**
 * The geofence and the retention window.
 *
 * `nearbyZoneRadiusMeters` **must** exceed `insideZoneRadiusMeters` — the server
 * refuses the save with INVALID_GEOFENCE otherwise — and `pingTimes` are `HH:mm`
 * strings, at most six of them.
 */
/**
 * The nightly "are you in tonight?" prompt.
 *
 * Lives inside the attendance settings rather than beside them because it is
 * one field on one document, written through the one endpoint — which is what
 * makes a warden's edit on their phone show up on the website without anything
 * syncing. Adding a second store for it is the way to break that.
 */
export type NightStatusPromptSettings = {
  promptEnabled: boolean;
  /** `HH:mm` in Nepal. The server refuses anything outside 17:00-23:45. */
  promptTime: string;
  /** How often non-responders are asked again: 15, 30 or 60. See `promptRound`. */
  repeatEveryMinutes: number;
};

export type AttendanceSettings = {
  absenceAlertDays: number;
  enabled: boolean;
  insideZoneRadiusMeters: number;
  nearbyZoneRadiusMeters: number;
  nightStatus: NightStatusPromptSettings;
  pingTimes: string[];
  retentionDays: number;
};

export async function getAttendanceSettings() {
  const response = await api.get<ApiEnvelope<{ settings: AttendanceSettings }>>(
    "/hostel-admin/attendance/settings",
  );

  return unwrap(response).settings;
}

export async function updateAttendanceSettings(
  input: Partial<Omit<AttendanceSettings, "nightStatus">> & {
    /*
     * Partial on its own account. The server merges this object field by field
     * rather than replacing it, so sending just the hour leaves the switch
     * alone — which is what lets this screen and the website each edit the part
     * they show without resetting the other's.
     */
    nightStatus?: Partial<NightStatusPromptSettings>;
  },
) {
  const response = await api.patch<
    ApiEnvelope<{ settings: AttendanceSettings }>
  >("/hostel-admin/attendance/settings", input);

  return unwrap(response).settings;
}

/**
 * `POST /hostel-admin/profile/change-request`.
 *
 * Three fields cannot be edited directly once a hostel is approved — its name
 * past the rename limit, the owner's name and the owner's account email — and go
 * to the platform team instead.
 */
export async function requestHostelChange(input: {
  changeType: "HOSTEL_NAME" | "OWNER_NAME" | "OWNER_EMAIL";
  reason?: string;
  requestedValue: string;
}) {
  await api.post("/hostel-admin/profile/change-request", input);
}

/**
 * `GET /hostel-admin/profile/geocode`.
 *
 * Both directions: `q` takes a place name, a pasted Google Maps or OSM link, or
 * a raw `lat,lng`; `lat` and `lng` answer with the address that pin sits on. It
 * is server-side because the map key must not ship in a client, and because
 * following a `maps.app.goo.gl` redirect is impossible from a browser.
 *
 * The server answers with `GeocodeResult` (`{ coordinates, label, address }`);
 * it is flattened here, once, so the pickers read `hit.lat` directly.
 */
export type GeocodeHit = {
  address?: string;
  area?: string;
  city?: string;
  displayName?: string;
  lat: number;
  lng: number;
  province?: string;
};

export async function geocodeHostelLocation(
  query: string | { lat: number; lng: number },
): Promise<GeocodeHit[]> {
  const response = await api.get<ApiEnvelope<{ results: LocationMatch[] }>>(
    "/hostel-admin/profile/geocode",
    // A pair asks the other way round: which address this pin sits on.
    { params: typeof query === "string" ? { limit: 6, q: query } : query },
  );

  return unwrap(response).results.map(({ address, coordinates, label }) => ({
    ...address,
    displayName: label,
    lat: coordinates.lat,
    lng: coordinates.lng,
  }));
}

/* -------------------------------------------------------------------------- */
/* Referrals                                                                  */
/* -------------------------------------------------------------------------- */

export type ReferralReward = {
  amount: number;
  id: string;
  notes: string;
  rewardType: string;
  status: string;
};

export type ManagedReferral = {
  confirmedAt?: string;
  converted: boolean;
  createdAt?: string;
  email: string;
  id: string;
  message: string;
  name: string;
  phone: string;
  referrerName: string;
  referrerPhone: string;
  reward: ReferralReward | null;
  status: string;
};

export type ReferralsPayload = {
  referrals: ManagedReferral[];
  /**
   * Describes **every** referral in scope, not the page and not the current
   * status filter — the service says so explicitly, because deriving it from the
   * returned rows would collapse the breakdown to one bucket the moment somebody
   * filtered by status.
   */
  summary: {
    byStatus: CountMap;
    converted: number;
    joined: number;
    pendingConfirmation: number;
    rewardApprovedAmount: number;
    rewardPaidAmount: number;
    rewardPendingAmount: number;
    total: number;
  };
  topReferrers: {
    code: string;
    id: string;
    joinedCount: number;
    name: string;
    rewardCount: number;
    roomType: string;
  }[];
};

export async function listReferrals(status?: string) {
  const response = await api.get<ApiEnvelope<ReferralsPayload>>(
    "/hostel-admin/referrals",
    {
      params: { pageSize: 50, status: status || undefined },
    },
  );

  return unwrap(response);
}

/** Marks the referred person as having actually moved in, and opens a reward. */
export async function confirmReferral(
  id: string,
  input: { rewardAmount: number; rewardNotes?: string; rewardType?: string },
) {
  await api.patch(`/hostel-admin/referrals/${id}/confirm`, input);
}

/**
 * Records the payout decision. Marking a reward PAID also moves the referral
 * itself to REWARDED, so the two can never disagree — and a referral still at
 * INQUIRY_CREATED is refused, because there is nothing to reward yet.
 */
export async function updateReferralReward(
  id: string,
  input: {
    amount?: number;
    notes?: string;
    rewardType?: string;
    status: "PENDING" | "APPROVED" | "PAID" | "CANCELLED";
  },
) {
  await api.patch(`/hostel-admin/referrals/${id}/reward`, input);
}

/* -------------------------------------------------------------------------- */
/* Move history — the web portal's Move-in / move-out record                 */
/* -------------------------------------------------------------------------- */

export type MoveEvent = {
  date: string;
  residentId: string;
  residentName: string;
  residentStatus: string;
  roomType: string;
  type: "MOVE_IN" | "MOVE_OUT";
};

export async function listMoveEvents() {
  const response = await api.get<ApiEnvelope<{ events: MoveEvent[] }>>(
    "/hostel-admin/move-events",
  );

  return unwrap(response).events;
}

/* -------------------------------------------------------------------------- */
/* Notification campaigns — the web portal's Notifications composer          */
/* -------------------------------------------------------------------------- */

export type NotificationCampaign = {
  audience: string;
  body: string;
  createdAt?: string;
  id: string;
  priority: string;
  recipientCount: number;
  scheduledFor?: string;
  sentAt?: string;
  stats: { delivered: number; read: number; sent: number };
  status: string;
  title: string;
};

export async function listNotificationCampaigns() {
  const response = await api.get<
    ApiEnvelope<{ campaigns: NotificationCampaign[] }>
  >("/hostel-admin/notifications");

  return unwrap(response).campaigns;
}

/** Bell + push to residents, guardians or picked residents; `scheduledFor` absent sends now. */
export async function sendNotificationCampaign(input: {
  audience: "ALL" | "GUARDIANS" | "SPECIFIC";
  body: string;
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  residentIds: string[];
  scheduledFor?: string;
  title: string;
}) {
  const response = await api.post<
    ApiEnvelope<{ campaign: NotificationCampaign }>
  >("/hostel-admin/notifications", { ...input, category: "ANNOUNCEMENT" });

  return unwrap(response).campaign;
}

/* -------------------------------------------------------------------------- */
/* Location attendance — the web portal's Attendance screen                  */
/* -------------------------------------------------------------------------- */

export type AttendanceZone = "INSIDE" | "NEARBY" | "OUTSIDE" | "UNKNOWN";

export type HostelAttendance = {
  summary: Record<AttendanceZone | "total", number>;
  today: {
    resident: { fullName: string; id: string; roomType?: string };
    zone: AttendanceZone;
  }[];
};

export type AttendanceAlert = {
  consecutiveDays: number;
  id: string;
  lastSeenAt?: string;
  residentName: string;
  resolutionNote?: string;
  status: string;
};

/** `GET /hostel-admin/attendance` — today's zone per active resident. Coordinates are never stored. */
export async function getHostelAttendance() {
  const response = await api.get<ApiEnvelope<HostelAttendance>>(
    "/hostel-admin/attendance",
  );

  return unwrap(response);
}

/** One resident's last 60 days, for the history grid. */
export async function getResidentAttendanceHistory(residentId: string) {
  const from = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
  const response = await api.get<
    ApiEnvelope<{ history: { day: string; zone: AttendanceZone }[] }>
  >("/hostel-admin/attendance", { params: { from, residentId } });

  return unwrap(response).history;
}

/** Sets today's zone by hand — the phone-was-off case. The reason is required and audited. */
export async function overrideAttendance(
  residentId: string,
  input: { reason: string; zone: AttendanceZone },
) {
  await api.patch(`/hostel-admin/attendance/${residentId}/override`, {
    ...input,
    day: new Date().toISOString(),
  });
}

export async function listAttendanceAlerts() {
  const response = await api.get<ApiEnvelope<{ alerts: AttendanceAlert[] }>>(
    "/hostel-admin/attendance/alerts",
  );

  return unwrap(response).alerts;
}

export async function resolveAttendanceAlert(alertId: string, note?: string) {
  await api.patch(
    `/hostel-admin/attendance/alerts/${alertId}/resolve`,
    note ? { note } : {},
  );
}

/* -------------------------------------------------------------------------- */
/* Invite hostels — this hostel's code for other hostels                     */
/* -------------------------------------------------------------------------- */

/** `GET /hostel-admin/hostel-referrals` — `getHostelInviteOverview` on the server. */
export type HostelInviteOverview = {
  code: string;
  enabled: boolean;
  link: string;
  referrals: {
    createdAt: string;
    hostelName: string;
    id: string;
    rewardAdded: boolean;
    rewardText: string;
    status: "PENDING" | "LIVE";
  }[];
  theyGet: { days: number; months: number; text: string };
  youGet: { days: number; months: number; text: string };
};

export async function getHostelInvites() {
  const response = await api.get<ApiEnvelope<HostelInviteOverview>>(
    "/hostel-admin/hostel-referrals",
  );

  return unwrap(response);
}

/** Emails the hostel's link. The server caps it at 20 a day per hostel. */
export async function sendHostelInvite(input: {
  email: string;
  name?: string;
}) {
  await api.post("/hostel-admin/hostel-referrals/invite", input);
}

/* -------------------------------------------------------------------------- */
/* Residents — intake, the record, and the two ends of a stay                 */
/* -------------------------------------------------------------------------- */

export const RESIDENT_TYPES = [
  "STUDENT",
  "WORKING_PROFESSIONAL",
  "OTHER",
] as const;

export type ResidentType = (typeof RESIDENT_TYPES)[number];

export const RESIDENT_STATUSES = [
  "PENDING",
  "ACTIVE",
  "SUSPENDED",
  "MOVED_OUT",
] as const;

export type ResidentStatus = (typeof RESIDENT_STATUSES)[number];

/**
 * The account a resident signs in with, when they have activated one.
 *
 * `image` is their profile picture — `/api/v1/users/<id>/avatar` for the photo
 * they put on their ID card, or their sign-in provider's. Relative and behind
 * auth, so it is `useAvatarSource()` that turns it into something an `<Image>`
 * can load; never hand it to a bare `<Avatar uri>`.
 *
 * `email` is deliberately not `Resident.email`: that is what the hostel wrote
 * down, and on a scanned intake it is the address off their profile form, which
 * need not be the one on their account.
 */
export type ResidentAccount = {
  email: string;
  image: string | null;
  name: string;
};

/** `serializeResident` in full. `AdminResident` in `admin-api.ts` is the row. */
export type ManagedResident = {
  /** Null until they activate a login. See {@link ResidentAccount}. */
  account?: ResidentAccount | null;
  /** What was levied at intake. Null — not zero — when none was. */
  admissionFee: number | null;
  admissionFeeDiscount: number;
  createdAt?: string;
  depositAmount: number;
  email: string;
  firstName: string;
  id: string;
  lastName: string;
  /** Zero is a real value — a free stay — and is not the same as "no override". */
  monthlyFee: number;
  moveInDate: string;
  phone: string;
  /** The code that brought them in. Empty when nobody referred them. */
  referralCode: string;
  residentType: string;
  roomType: string;
  status: string;
  /** Present once they have activated an account. Absent means they never have. */
  userId?: string;
};

export async function getResident(id: string) {
  const response = await api.get<ApiEnvelope<{ resident: ManagedResident }>>(
    `/hostel-admin/residents/${id}`,
  );

  return unwrap(response).resident;
}

/** What the server did with the money, alongside the resident it created. */
export type ResidentIntakeResult = {
  /**
   * Whether registering them also turned their existing website account into a
   * resident login.
   *
   * `linked: false` is ordinary rather than broken, and `reason` says which of
   * the four it was: `NO_EMAIL` (nobody typed one), `NO_ACCOUNT` (that mailbox
   * has never signed up — accounts are never created here, because that would
   * mean mailing somebody a password), `EMAIL_ALREADY_HAS_ROLE` (it is a staff
   * or owner account) or `ACCOUNT_ALREADY_LINKED` (they still hold a live
   * resident profile somewhere). All four end the same way: the resident
   * redeems an activation code instead.
   *
   * Even when it is `true`, a browser or app already signed in on that account
   * keeps its old role until the access token expires — the role is re-read
   * from the database on refresh, not on registration.
   */
  accountLink: { linked: boolean; reason?: string };
  /** The one-off admission invoice, or why there is none. */
  admission:
    | { amount: number; invoiceId: string; raised: true; referenceCode: string }
    | { raised: false; reason: string };
  /**
   * The move-in month's rent, raised as part of the intake.
   *
   * `raised: false` is an ordinary outcome, not a failure: a `PENDING` resident
   * is not billable until somebody admits them (`NOT_YET_RESIDENT`), and a
   * hostel with no rate card cannot be billed at all. The resident is registered
   * either way — see `raiseFirstMonthInvoice` on the server.
   */
  firstMonth:
    | {
        amount: number;
        invoiceId: string;
        period: string;
        raised: true;
        referenceCode: string;
      }
    | { period: string; raised: false; reason: string };
  /**
   * How this hostel takes money, resolved server-side at the moment of
   * registration (`getHostelPayMethods`).
   *
   * Returned with the intake rather than fetched afterwards because the desk
   * is the one moment a reference code is guaranteed to reach the person who
   * owes it — they are standing there. Sending a warden away to find the
   * hostel's eSewa id somewhere else is how a transfer arrives with no
   * reference and lands in the owner's review queue as an unidentifiable
   * credit.
   *
   * `null` when the lookup failed, and `usable: false` when the owner has not
   * set a payment profile up at all; both are said out loud rather than shown
   * as an empty list. Optional because this build can be older than the API.
   */
  howToPay?: {
    displayName: string | null;
    instructions: string | null;
    methods: PayMethod[];
    usable: boolean;
  } | null;
  quote: IntakeQuote;
  referral: { code: string } | null;
  resident: ManagedResident;
};

/**
 * `POST /hostel-admin/residents`.
 *
 * Admitting somebody **takes a bed** off their room type, so a full type is
 * refused here rather than discovered later. `referralCode` is what pays a
 * resident for bringing a friend in — it is the only place that link is made,
 * so an intake that forgets it cannot be corrected afterwards.
 *
 * **There is no `monthlyFee`.** Intake does not set a rent: the rate card does,
 * and {@link getIntakeQuote} is how a screen shows what that will be. The field
 * used to be here and defaulted to zero, which `resolveMonthlyCharge` reads as a
 * deliberate free stay — so every resident registered from this app was quietly
 * billed nothing. A negotiated rate is an override, set on the resident's own
 * screen where a reason is recorded with it.
 */
export async function createResident(input: {
  depositAmount?: number;
  email?: string;
  firstName: string;
  lastName: string;
  /** ISO. */
  moveInDate: string;
  phone: string;
  referralCode?: string;
  residentType?: ResidentType;
  roomType: string;
  status?: ResidentStatus;
  /**
   * The platform resident ID that was scanned to open this intake, when one
   * was — `HH-4K7M-9XQ2`, exactly as {@link lookupResidentProfile} received it.
   *
   * **Send it whenever there is one.** It is what tells the server which account
   * to turn into a resident login. Without it the server can only look the
   * person up by the email on the form, which comes off their profile rather
   * than their sign-in, so a scanned resident whose two addresses had drifted
   * apart was registered and then left with no portal at all.
   */
  userResidentId?: string;
}) {
  const response = await api.post<ApiEnvelope<ResidentIntakeResult>>(
    "/hostel-admin/residents",
    input,
  );

  return unwrap(response);
}

/* -------------------------------------------------------------------------- */
/* Intake — reading a card, and what the stay costs                           */
/* -------------------------------------------------------------------------- */

/**
 * A resident's own profile, as they filled it in before their ID card was
 * issued — `GET /hostel-admin/resident-lookup`.
 *
 * Sibling of `resident-scan` in `admin-scan-api.ts`, and the difference decides
 * which one a screen wants. **Scan describes somebody**: it tolerates a missing
 * profile, a provider's card and sharing switched off, because the warden in the
 * corridor still needs to know who they are holding. **Lookup fills a form**, so
 * it refuses all three — there is no half-registering somebody off a card that
 * cannot answer for them. A 404 here means "not a resident card, or their
 * profile is not finished", and that is the honest end of the intake.
 *
 * Reading a profile this way **notifies its owner** and is written to the audit
 * log. That is deliberate and it is the reason the lookup is not used for idle
 * curiosity: a resident is told each time a hostel opens their details.
 */
export type ResidentPrefill = {
  details: {
    age: number | null;
    alternatePhone: string | null;
    backupEmail: string | null;
    bloodGroup: string;
    budgetRange: string | null;
    city: string | null;
    courseOrDesignation: string | null;
    dateOfBirth: string | null;
    dietaryPreference: string;
    gender: string;
    governmentIdNumber: string | null;
    governmentIdType: string | null;
    institution: string | null;
    interests: string[];
    medicalNotes: string | null;
    permanentAddress: string | null;
    province: string | null;
  };
  emergencyContact: {
    isPrimary: boolean;
    name: string;
    phone: string;
    relation: string;
  };
  guardians: {
    email?: string;
    firstName: string;
    isPrimary: boolean;
    lastName: string;
    phone: string;
    relation: string;
  }[];
  resident: {
    email: string;
    firstName: string;
    lastName: string;
    phone: string;
    residentType: string;
  };
};

/**
 * Whether the card holder has a photograph, and which version of it.
 *
 * The bytes come from `/hostel-admin/resident-scan/photo` — build the source
 * with `residentCardPhotoSource`, which is what the corridor scan uses too.
 */
export type ResidentPrefillPhoto = {
  hasPhoto: boolean;
  updatedAt: string | null;
};

/**
 * Where the scanned person already lives, when they live anywhere —
 * `lookupResidentProfile`'s `occupancy`.
 *
 * Matched by their account and by email. `residentId` is set only when it is
 * **this** hostel's own record; another hostel's is never sent. The server
 * refuses the registration either way, so this is what lets the screen say so
 * before the warden has picked a bed rather than after.
 */
export type ResidentOccupancy = {
  hostelId: string;
  hostelName: string;
  residentId: string | null;
  sameHostel: boolean;
  status: "ACTIVE" | "PENDING" | "SUSPENDED";
};

export async function lookupResidentProfile(residentId: string) {
  const response = await api.get<
    ApiEnvelope<{
      /*
       * Optional because an API deployed before it existed does not send it,
       * and absent reads as "no conflict found" — the create call still
       * refuses on a server that has the check.
       */
      occupancy?: ResidentOccupancy | null;
      photo: ResidentPrefillPhoto;
      prefill: ResidentPrefill;
      residentId: string;
      sharedAt: string;
    }>
  >("/hostel-admin/resident-lookup", { params: { residentId } });

  return unwrap(response);
}

/** Where {@link IntakeQuote.monthlyRent} came from. `UNPRICED` means nowhere. */
export type RentBasis = "ROOM_CONFIGURATION" | "SCHEDULE" | "UNPRICED";

/**
 * What this intake costs, resolved by the server — `GET .../residents/intake-quote`.
 *
 * Every figure here is a **fact to display, not a field to edit**. The rate card
 * it comes from sits behind `viewPayments`, which a warden does not have; this
 * route is gated on `registerResidents` instead, so the person admitting
 * somebody is told the price rather than asked for it.
 */
/**
 * What the **move-in month** costs, which is rarely what a month costs.
 *
 * Somebody admitted on the 20th owes twelve days of a thirty-one-day month, and
 * a full month from the next one on. The server computes this through the same
 * function the billing run uses, so the figure quoted at the desk is the figure
 * on the invoice raised seconds later.
 *
 * Branch on `prorated`, never on `amount !== monthlyRent`: they are equal for
 * anybody arriving on the 1st, and a first-month row that vanishes on the 1st of
 * the month is a row nobody can explain.
 */
export type FirstMonthCharge = {
  amount: number;
  /** Days they are resident for, inclusive of the move-in day. */
  billableDays: number;
  daysInMonth: number;
  /** `2026-08` — the period the invoice carries. */
  period: string;
  prorated: boolean;
};

export type IntakeQuote = {
  /** Before the referral discount. */
  admissionFee: number;
  /** Fee less discount — what is actually collected at the door. */
  admissionPayable: number;
  formFee?: number;
  bedType: string | null;
  currency: string;
  depositAmount: number;
  feeScheduleId: string | null;
  /** Null when there is no rent to prorate — same cases as `monthlyRent`. */
  firstMonth: FirstMonthCharge | null;
  /** Null when nothing prices this room type. Check `rentBasis`, never assume 0. */
  monthlyRent: number | null;
  referral: {
    applied: boolean;
    code: string | null;
    discount: number;
    /** Why a code earned nothing, ready to print under the field. */
    reason: string | null;
  };
  rentBasis: RentBasis;
  roomType: string;
};

export async function getIntakeQuote(input: {
  /** ISO. Decides which rate card is in force. */
  moveInDate?: string;
  referralCode?: string;
  roomType: string;
}) {
  const response = await api.get<ApiEnvelope<{ quote: IntakeQuote }>>(
    "/hostel-admin/residents/intake-quote",
    { params: input },
  );

  return unwrap(response).quote;
}

/**
 * `PATCH /hostel-admin/residents/{id}`.
 *
 * Two edits are not what they look like: a **phone** already on the roll is a
 * 409 rather than a duplicate row, and a **room type** change moves a unit of
 * vacancy between types — which fails outright if the destination is full.
 */
export async function updateResident(
  id: string,
  input: {
    depositAmount?: number;
    email?: string;
    firstName?: string;
    lastName?: string;
    monthlyFee?: number;
    moveInDate?: string;
    phone?: string;
    residentType?: ResidentType;
    roomType?: string;
  },
) {
  await api.patch(`/hostel-admin/residents/${id}`, input);
}

export async function setResidentStatus(id: string, status: ResidentStatus) {
  await api.patch(`/hostel-admin/residents/${id}/status`, { status });
}

/** Soft-deletes and hands the bed back. Payments and complaints still reference them. */
export async function deleteResident(id: string) {
  await api.delete(`/hostel-admin/residents/${id}`);
}

/**
 * The per-resident fee override — `PATCH /hostel-admin/residents/fees`.
 *
 * **`monthlyFee: null` is the interesting value.** It clears the override and
 * hands the resident back to the hostel's fee schedule, which is the one thing
 * a plain number cannot express. Zero is a *deliberate free stay* and survives:
 * the charge resolver tests for null, not for falsiness.
 *
 * Wants `manageFeeSchedule`, which a warden does not have by default.
 */
export async function setResidentFee(input: {
  monthlyFee: number | null;
  reason?: string;
  residentIds?: string[];
}) {
  await api.patch("/hostel-admin/residents/fees", input);
}

export type ResidentGuardian = {
  email: string;
  firstName: string;
  id: string;
  isPrimary: boolean;
  lastName: string;
  phone: string;
  relation: string;
};

export type ResidentEmergencyContact = {
  id: string;
  isPrimary: boolean;
  name: string;
  phone: string;
  relation: string;
};

export async function listResidentContacts(id: string) {
  const response = await api.get<
    ApiEnvelope<{
      emergencyContacts: ResidentEmergencyContact[];
      guardians: ResidentGuardian[];
    }>
  >(`/hostel-admin/residents/${id}/contacts`);

  return unwrap(response);
}

export async function addResidentGuardian(
  id: string,
  input: {
    email?: string;
    firstName: string;
    isPrimary?: boolean;
    lastName: string;
    phone: string;
    relation: string;
  },
) {
  await api.post(`/hostel-admin/residents/${id}/guardians`, input);
}

export async function addEmergencyContact(
  id: string,
  input: { isPrimary?: boolean; name: string; phone: string; relation: string },
) {
  await api.post(`/hostel-admin/residents/${id}/emergency-contacts`, input);
}

/**
 * `POST .../activation-code` issues one; `PATCH` reissues, cancelling whatever
 * was outstanding.
 *
 * **The plaintext code is returned exactly once**, in this response — only its
 * hash is stored — so a screen that does not show it has thrown it away. Email
 * delivery is best-effort and reports itself in `delivery`: the code is valid
 * whether or not the mail went, which is why `sendEmail: false` plus reading it
 * aloud is a supported way to do this.
 */
export type ActivationIssue = {
  activation: { code?: string; expiresAt?: string; id: string; status: string };
  delivery: { reason?: string; sent: boolean };
};

export async function issueActivationCode(
  id: string,
  input: { expiresInHours?: number; reissue?: boolean; sendEmail?: boolean },
) {
  const body = {
    expiresInHours: input.expiresInHours,
    sendEmail: input.sendEmail ?? true,
  };

  const response = input.reissue
    ? await api.patch<ApiEnvelope<ActivationIssue>>(
        `/hostel-admin/residents/${id}/activation-code`,
        body,
      )
    : await api.post<ApiEnvelope<ActivationIssue>>(
        `/hostel-admin/residents/${id}/activation-code`,
        body,
      );

  return unwrap(response);
}

export type MoveInChecklist = {
  bedCondition: string;
  completedAt?: string;
  depositAmount: number;
  documentsCollected: string[];
  id: string;
  itemsProvided: string[];
  roomCondition: string;
  roomPhotoAssetIds: string[];
  rulesAccepted: boolean;
};

export type MoveOutChecklist = {
  completedAt?: string;
  damageNotes: string;
  depositRefundAmount: number;
  depositRefundDecision: string;
  finalReceiptAssetId: string;
  id: string;
  itemReturnNotes: string;
  /** What they still owe, computed by the service rather than typed in. */
  pendingFeeAmount: number;
};

export async function getMoveInChecklist(id: string) {
  const response = await api.get<
    ApiEnvelope<{ checklist: MoveInChecklist | null }>
  >(`/hostel-admin/residents/${id}/move-in`);

  return unwrap(response).checklist;
}

export async function saveMoveInChecklist(
  id: string,
  input: {
    bedCondition?: string;
    depositAmount: number;
    documentsCollected: string[];
    itemsProvided: string[];
    roomCondition?: string;
    roomPhotoAssetIds: string[];
    rulesAccepted: boolean;
  },
) {
  await api.post(`/hostel-admin/residents/${id}/move-in`, input);
}

/** The recorded move-out, if any, and what they owe right now. */
export async function getMoveOutChecklist(id: string) {
  const response = await api.get<
    ApiEnvelope<{
      checklist: MoveOutChecklist | null;
      pendingFeeAmount?: number;
    }>
  >(`/hostel-admin/residents/${id}/move-out`);

  return unwrap(response);
}

/**
 * `POST .../move-out` — moves them out in one call: sets MOVED_OUT, frees the
 * bed once, and records the deposit decision. The server sets the refund amount
 * from the decision; only a partial refund's typed amount is used.
 */
export async function saveMoveOutChecklist(
  id: string,
  input: {
    damageNotes?: string;
    depositRefundAmount: number;
    depositRefundDecision: "PENDING" | "APPROVED" | "PARTIAL" | "FORFEITED";
    itemReturnNotes?: string;
  },
) {
  await api.post(`/hostel-admin/residents/${id}/move-out`, input);
}

/* -------------------------------------------------------------------------- */
/* Inquiries                                                                  */
/* -------------------------------------------------------------------------- */

export const INQUIRY_STATUSES = [
  "NEW",
  "CONTACTED",
  "VISIT_SCHEDULED",
  "CONVERTED",
  "CLOSED",
] as const;

export type InquiryStatus = (typeof INQUIRY_STATUSES)[number];

/**
 * A lead, as the inquiries screen renders it — `GET /hostel-admin/inquiries`.
 *
 * Wider than `AdminInquiry` in `admin-api.ts`, which carries only what the
 * alert feed needs to draw a one-line row. The difference is deliberate rather
 * than duplication: the feed's copy is fetched with `status=NEW` as part of the
 * four-source alerts pull, and this one is the whole queue with its history.
 */
export type ManagedInquiry = {
  budgetRange: string;
  createdAt?: string;
  email: string;
  gender: string;
  id: string;
  message: string;
  name: string;
  phone: string;
  preferredRoomType: string;
  preferredVisitDate?: string;
  source: string;
  status: InquiryStatus;
  updatedAt?: string;
};

/**
 * The hostel's leads — `GET /hostel-admin/inquiries`.
 *
 * `pageSize` is generous because this screen has no pagination and should not
 * grow one: an inquiry is a conversation somebody either answers or closes, and
 * a hostel with two hundred open leads has a process problem the app cannot fix
 * by adding a *next page* button. The status segments are what keeps the list
 * short.
 */
export async function listManagedInquiries(
  query: { status?: InquiryStatus } = {},
) {
  const response = await api.get<ApiEnvelope<{ inquiries: ManagedInquiry[] }>>(
    "/hostel-admin/inquiries",
    {
      params: {
        pageSize: 100,
        ...(query.status ? { status: query.status } : {}),
      },
    },
  );

  return unwrap(response).inquiries;
}

/**
 * Moving a lead along — `PATCH /hostel-admin/inquiries/{id}/status`.
 *
 * `CONVERTED` records that this person took a bed; it does **not** create the
 * resident. Registering them is a separate act, which is right — the inquiry is
 * a conversation and the resident is a tenancy — but it means an inquiry marked
 * converted with nobody registered is a real and invisible state.
 */
export async function setInquiryStatus(id: string, status: InquiryStatus) {
  await api.patch(`/hostel-admin/inquiries/${id}/status`, { status });
}

/**
 * `POST /hostel-admin/inquiries/{id}/notes`.
 *
 * `nextFollowUpAt` is the reason to use it over remembering: it is what turns
 * "call them back" into something the hostel can be reminded of.
 */
export async function addInquiryNote(
  id: string,
  input: { nextFollowUpAt?: string; note: string },
) {
  await api.post(`/hostel-admin/inquiries/${id}/notes`, input);
}

/* -------------------------------------------------------------------------- */
/* Finance — rates, billing, where money goes, and reconciling it             */
/* -------------------------------------------------------------------------- */

/**
 * The pricing vocabulary, copied from `@hostel/shared/types/bed-type`.
 *
 * Mobile does not depend on `packages/shared` — nothing in it is wired into the
 * Expo bundler — so the five words are restated here. **`bedType` is not
 * `roomType`:** `roomType` is free text, is what capacity accounting matches on
 * by string equality, and is what fifteen screens display. `bedType` is the
 * pricing key a fee schedule and an invoice carry. A hostel can have a room type
 * called "Boys 3-sharing" priced by the `TRIPLE_SHARING` rate.
 */
export const BED_TYPES = [
  "SINGLE",
  "DOUBLE_SHARING",
  "TRIPLE_SHARING",
  "FOUR_SHARING",
  "DORMITORY",
] as const;

export type BedType = (typeof BED_TYPES)[number];

export const BED_TYPE_LABELS: Record<BedType, string> = {
  DORMITORY: "Dormitory",
  DOUBLE_SHARING: "Double sharing",
  FOUR_SHARING: "Four sharing",
  SINGLE: "Single",
  TRIPLE_SHARING: "Triple sharing",
};

/**
 * One rate, keyed by the hostel's own room type.
 *
 * `bedType` used to be the key, and that is why the platform stored a price
 * twice: it is a five-value enum derived from free text, it cannot express a
 * hostel whose rooms are called "Shared", so `roomConfigurations[].monthlyRent`
 * had to stay as a second store — and the two drifted until a hostel advertised
 * 18,000 and invoiced 174,000. It survives as a derived reporting label the
 * server writes; never send it.
 *
 * Both are optional because a card saved before the re-key carries only the
 * bed type, and history has to stay readable.
 */
export type FeeScheduleRate = {
  bedType?: string | null;
  monthlyAmount: number;
  roomType?: string | null;
};

/** A room type the hostel offers, with what its public listing says today. */
export type FeeScheduleRoomType = { monthlyRent: number; roomType: string };

/**
 * Labels each card `current` / `upcoming` / `past` when the server has not.
 *
 * The server computes `standing` and is the authority on it, but the app ships
 * separately from the API and reaches a phone before a deploy does. This build
 * ran against an API that had never heard of the field: every card came back
 * unlabelled, nothing matched `current` or `upcoming`, and the Finance screen
 * told a hostel with three rate cards that it had **No rates set**. A client
 * that hard-depends on a field the server may not send yet is a client that
 * breaks on deploy order.
 *
 * Same rule as the server's `labelSchedules`: the current card is the newest one
 * whose span covers this month, which is how billing picks it. Not
 * `effectiveTo === null` — a card closed to make room for a successor can still
 * be the one billing, while the open row may not start for weeks.
 */
function withStanding(schedules: FeeSchedule[]): FeeSchedule[] {
  if (schedules.every((schedule) => schedule.standing)) {
    return schedules;
  }

  const now = new Date();
  const monthStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const monthEnd = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    0,
    23,
    59,
    59,
    999,
  );
  const from = (schedule: FeeSchedule) =>
    new Date(schedule.effectiveFrom).getTime();
  const to = (schedule: FeeSchedule) =>
    schedule.effectiveTo === null
      ? null
      : new Date(schedule.effectiveTo).getTime();

  const current = schedules
    .filter((schedule) => {
      const end = to(schedule);

      return from(schedule) <= monthEnd && (end === null || end >= monthStart);
    })
    .sort((a, b) => from(b) - from(a))[0];

  return schedules.map((schedule) => ({
    ...schedule,
    standing:
      schedule === current
        ? ("current" as const)
        : from(schedule) > monthEnd
          ? ("upcoming" as const)
          : ("past" as const),
  }));
}

/**
 * Room types recovered from the cards, for an API that does not send them.
 *
 * A poor substitute and deliberately so: it can only name room types somebody
 * has already priced, so a hostel's unpriced rooms stay invisible until the API
 * is updated. Still better than a rate editor with no boxes in it at all. Cards
 * from before the room-type re-key carry only a bed type, which is at least a
 * label a person recognises.
 */
function roomTypesFromSchedules(
  schedules: FeeSchedule[],
): FeeScheduleRoomType[] {
  const seen = new Map<string, FeeScheduleRoomType>();

  for (const schedule of schedules) {
    for (const rate of schedule.rates) {
      const roomType = rate.roomType ?? rate.bedType;

      if (roomType && !seen.has(roomType)) {
        seen.set(roomType, { monthlyRent: 0, roomType });
      }
    }
  }

  return [...seen.values()].sort((a, b) =>
    a.roomType.localeCompare(b.roomType),
  );
}

/** The rate cards plus the room types they are keyed by. */
export type FeeScheduleData = {
  roomTypes: FeeScheduleRoomType[];
  schedules: FeeSchedule[];
};

/**
 * A rate card, with the dates it governs.
 *
 * `effectiveTo: null` is the open schedule — there is exactly one per hostel and
 * a partial unique index enforces it.
 */
export type FeeSchedule = {
  _id: string;
  admissionFee?: number;
  formFee?: number;
  createdAt?: string;
  depositAmount?: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  rates: FeeScheduleRate[];
  /**
   * Whether these rates are billing residents today, are only booked for a
   * future month, or have finished.
   *
   * Decided by the server. `effectiveTo === null` is **not** the same question:
   * for the whole month between setting new rates and them starting, the open
   * row is an upcoming card while a closed one is doing the billing. Reading the
   * open row as "active" is what showed an owner 18,000 as live while their
   * residents were being invoiced at 180,000.
   */
  standing?: "current" | "past" | "upcoming";
  /**
   * What comes off the admission fee for a resident who arrives on another
   * resident's referral code. Never off the rent — a referral is a one-time
   * thank-you, not a standing rate.
   */
  referralAdmissionDiscount?: number;
};

/**
 * The rate cards **and** the room types they are keyed by.
 *
 * The room types come back together with the cards because they are the keys of
 * a card, not context for it — an editor that fetched them separately could
 * offer a rate box for a room type the hostel no longer rents.
 */
/**
 * `DELETE /hostel-admin/finance/fee-schedules/{id}`.
 *
 * Only rates that have not started. One that is billing residents is history and
 * the server refuses it — an invoice may already carry its id, and an orphaned
 * `feeScheduleId` makes "what was this resident's rent in March?" unanswerable.
 * Deleting puts the previous rates back, so a hostel is never left unable to
 * bill by dropping *next* month's card.
 */
export async function deleteFeeSchedule(scheduleId: string) {
  const response = await api.delete<
    ApiEnvelope<{ deletedId: string; restoredId: string | null }>
  >(`/hostel-admin/finance/fee-schedules/${encodeURIComponent(scheduleId)}`);

  return unwrap(response);
}

export async function listFeeSchedules() {
  const response = await api.get<
    ApiEnvelope<{ roomTypes?: FeeScheduleRoomType[]; schedules: FeeSchedule[] }>
  >("/hostel-admin/finance/fee-schedules");
  const data = unwrap(response);
  const schedules = withStanding(data.schedules ?? []);

  return {
    roomTypes: data.roomTypes ?? roomTypesFromSchedules(schedules),
    schedules,
  };
}

/**
 * `POST /hostel-admin/finance/fee-schedules`.
 *
 * **There is no edit and no PUT, deliberately.** Opening a schedule closes the
 * current one the day before the new one starts; the old rates stay readable so
 * an invoice issued from them can be explained rather than merely trusted.
 * Editing in place would silently rewrite the basis of every invoice already
 * issued — the behaviour of the bulk fee-setter this replaced.
 *
 * At least one rate is required: an empty card prices nobody, and every resident
 * would fail the next billing run with `BED_TYPE_NOT_PRICED`. Amounts are whole
 * rupees, checked at three separate gates.
 */
export async function createFeeSchedule(input: {
  admissionFee?: number;
  formFee?: number;
  depositAmount?: number;
  /** ISO. */
  effectiveFrom: string;
  rates: { monthlyAmount: number; roomType: string }[];
  /** Refused server-side if it exceeds `admissionFee`. */
  referralAdmissionDiscount?: number;
}) {
  await api.post("/hostel-admin/finance/fee-schedules", input);
}

export async function closeFeeSchedule(id: string, effectiveTo: string) {
  await api.post(`/hostel-admin/finance/fee-schedules/${id}/close`, {
    effectiveTo,
  });
}

/* -------------------------------------------------------------------------- */
/* Festival discounts                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A month at reduced rent, sitting on top of the rate card.
 *
 * Not a rate card of its own, and that is the whole shape of it: the rents above
 * are unchanged, and this says "in Kartik, take 50% off everybody". Said through
 * the card instead it would take three cards to express one festival, with the
 * real rents then living in two rows that agree only by accident.
 *
 * `standing` is the server's, like a schedule's. `past` months are already
 * invoiced and their bills carry the figure they were issued with — so a discount
 * on one changes no money, and the screen says so rather than refusing the save.
 */
/**
 * What a save or a delete did to bills that had **already gone out** for that
 * month — see `rent-concession-backfill` on the server.
 *
 * All zeroes is the healthy case, not a failure: it means the month has not been
 * billed yet, so the run will charge the reduced rent directly and there was
 * nothing to correct.
 */
export type ConcessionBackfill = {
  /** Rupees taken off, or put back. */
  discounted: number;
  invoicesChanged: number;
  /** Left at their discount because money is already settled against them. */
  invoicesKept: number;
  /** Already paid, so handed back as credit against next month. */
  refundedAsCredit: number;
};

export type RentConcession = {
  _id: string;
  /** "Kartik 2083" — the month as an owner reads it. */
  label: string;
  percentOff: number;
  /** BS period key, `2083-06`. */
  period: string;
  reason: string | null;
  standing: "current" | "past" | "upcoming";
};

export async function listRentConcessions() {
  const response = await api.get<
    ApiEnvelope<{ concessions: RentConcession[] }>
  >("/hostel-admin/finance/rent-concessions");

  return unwrap(response).concessions ?? [];
}

/**
 * `POST /hostel-admin/finance/rent-concessions` — set or replace one month.
 *
 * An upsert keyed on the month, so there is no edit endpoint and no id to hold:
 * "Dashain at 50, no — 40" is a correction to one fact. Invoices already issued
 * are untouched either way, because each carries the amount it was computed from.
 */
export async function saveRentConcession(input: {
  percentOff: number;
  period: string;
  reason?: string;
}) {
  const response = await api.post<
    ApiEnvelope<{
      concession: RentConcession & { applied: ConcessionBackfill };
    }>
  >("/hostel-admin/finance/rent-concessions", input);

  return unwrap(response).concession;
}

export async function deleteRentConcession(id: string) {
  const response = await api.delete<
    ApiEnvelope<{ deletedId: string; restored: ConcessionBackfill }>
  >(`/hostel-admin/finance/rent-concessions/${encodeURIComponent(id)}`);

  return unwrap(response);
}

/** `GET .../billing-runs?period=` — what the period looks like now. Reads never bill. */
export type BillingPeriodSummary = {
  invoiceCount: number;
  notBilledResidentIds: string[];
  period: string;
  totalBilled: number;
};

export async function getBillingPeriod(period: string) {
  const response = await api.get<ApiEnvelope<BillingPeriodSummary>>(
    "/hostel-admin/finance/billing-runs",
    { params: { period } },
  );

  return unwrap(response);
}

export type BillingRunResult = {
  billed: {
    amount: number;
    creditApplied: number;
    invoiceId: string;
    referenceCode: string;
    residentId: string;
  }[];
  failures: { errorCode: string; message: string; residentId: string }[];
  period: string;
  skipped: { detail?: string; reason: string; residentId: string }[];
  totalBilled: number;
};

/**
 * Issues a month of invoices — `POST .../billing-runs`.
 *
 * **No amount is sent, and that is the point.** The run this replaced took a
 * `defaultAmount` from the request body and fell back to it whenever a resident
 * had no fee, which is how somebody got billed a number nobody chose. Amounts
 * come from the fee schedule and the per-resident override, and from nowhere
 * else — so a resident with no rate *fails* into `failures` rather than being
 * quietly billed a guess.
 *
 * Re-running a period is safe: already-billed residents land in `skipped`.
 */
export async function runBilling(input: {
  /** ISO. Absent means the last day of the period. */
  dueDate?: string;
  /** `YYYY-MM`. */
  period: string;
  /** Absent means every billable resident. */
  residentIds?: string[];
}) {
  const response = await api.post<ApiEnvelope<BillingRunResult>>(
    "/hostel-admin/finance/billing-runs",
    input,
  );

  return unwrap(response);
}

/**
 * How this hostel takes money.
 *
 * Read is `viewPayments`; every write is `managePaymentProfile`. They were split
 * apart on purpose: the warden who approves payment proofs must not also be able
 * to change the account the money is asked to go to.
 *
 * `payeeVerifiable` is the one field worth understanding. `usable` says
 * residents have somewhere to send money; `payeeVerifiable` says we can
 * recognise this hostel on the receipt that comes back. A hostel with only a
 * static QR is perfectly usable and yet every claim it receives reads UNKNOWN on
 * the payee — the one check a payer cannot fake is switched off, silently.
 */
export type PaymentProfile = {
  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankName: string | null;
  cashApprovalThreshold: number;
  displayName: string | null;
  enabledProviders: string[];
  esewaId: string | null;
  /** A second bank or wallet. Saved as one list — see `updatePaymentProfile`. */
  extraAccounts: ExtraPaymentAccount[];
  khaltiId: string | null;
  lastStatementUploadAt: string | null;
  payeeVerifiable: boolean;
  paymentInstructions: string | null;
  qrPayeeName: string | null;
  qrPayeeNumber: string | null;
  qrPayeeSource: "MANUAL" | "OCR" | null;
  staticQrAssetId: string | null;
  statementCadenceDays: number;
  tier: string;
  usable: boolean;
};

export type ExtraPaymentAccount = {
  accountName: string | null;
  bankName: string | null;
  kind: "BANK" | "ESEWA" | "KHALTI";
  number: string;
};

export async function getPaymentProfile() {
  const response = await api.get<ApiEnvelope<{ profile: PaymentProfile }>>(
    "/hostel-admin/finance/payment-profile",
  );

  return unwrap(response).profile;
}

export async function updatePaymentProfile(input: {
  bankAccountName?: string;
  bankAccountNumber?: string;
  bankName?: string;
  cashApprovalThreshold?: number;
  displayName?: string;
  esewaId?: string;
  /** Replaces the whole list; an empty list clears it. */
  extraAccounts?: {
    accountName?: string;
    bankName?: string;
    kind: ExtraPaymentAccount["kind"];
    number: string;
  }[];
  khaltiId?: string;
  paymentInstructions?: string;
  qrPayeeName?: string;
  qrPayeeNumber?: string;
  /** Null removes the QR image. */
  staticQrAssetId?: string | null;
  statementCadenceDays?: number;
}) {
  const response = await api.patch<ApiEnvelope<{ profile: PaymentProfile }>>(
    "/hostel-admin/finance/payment-profile",
    input,
  );

  return unwrap(response).profile;
}

export const GATEWAY_PROVIDERS = ["ESEWA", "FONEPAY", "KHALTI"] as const;

export type GatewayProviderName = (typeof GATEWAY_PROVIDERS)[number];

/**
 * One provider's setup.
 *
 * The signing secret is **write-only in both directions** — there is no field
 * that returns one and no code path that could. What comes back is
 * `{ configured, fingerprint, rotatedAt }`, which is enough to say "a key is
 * installed and it is this one" without saying what it is.
 *
 * `blockedReason` is why this entry cannot be switched on, in words meant for
 * the owner — a personal wallet is stored and never payable, and the reason says
 * so rather than the form hiding the option.
 */
export type GatewayConfig = {
  accountKind: string;
  blockedReason: string | null;
  enabled: boolean;
  enabledAt: string | null;
  health: { detail: string | null; status: string } | null;
  lastEventAt: string | null;
  lastVerifiedAt: string | null;
  merchantCode: string | null;
  mode: string;
  payable: boolean;
  provider: string;
  secret: {
    configured: boolean;
    fingerprint: string | null;
    rotatedAt: string | null;
  };
  webhookSecret: {
    configured: boolean;
    fingerprint: string | null;
    rotatedAt: string | null;
  };
};

/** Even the read wants `managePaymentProfile` — it lists merchant codes. */
export async function listGateways() {
  const response = await api.get<ApiEnvelope<{ gateways: GatewayConfig[] }>>(
    "/hostel-admin/finance/payment-gateways",
  );

  return unwrap(response).gateways;
}

/**
 * `PUT .../payment-gateways`.
 *
 * Omitting `secret` means "leave whatever is stored alone", which is what an
 * owner editing a merchant code needs — they cannot see the key to retype it. An
 * empty string is *rejected* rather than read as a deletion: deleting a key is
 * the DELETE route, and a blank field is far more often a form that failed to
 * populate.
 */
export async function saveGateway(input: {
  accountKind?: "MERCHANT" | "PERSONAL";
  enabled?: boolean;
  merchantCode?: string;
  mode?: "LIVE" | "SANDBOX";
  provider: GatewayProviderName;
  secret?: string;
  webhookSecret?: string;
}) {
  const response = await api.put<ApiEnvelope<{ gateways: GatewayConfig[] }>>(
    "/hostel-admin/finance/payment-gateways",
    input,
  );

  return unwrap(response).gateways;
}

export async function deleteGateway(provider: GatewayProviderName) {
  await api.delete("/hostel-admin/finance/payment-gateways", {
    params: { provider },
  });
}

/**
 * `POST .../invoices/{id}/cash`.
 *
 * Compare what the deleted PATCH accepted — `paidAmount`, `paidDate`, `status`
 * and `paymentMethod`, any of them settable to anything. Here the amount is the
 * only number the caller supplies, and it arrives with the two facts that make
 * it answerable months later: **who physically took the money** (frequently not
 * the person typing) and **which paper receipt it is on**. That receipt number
 * is also the idempotency key, which is why it cannot be blank — the app mints
 * one per sheet opening, so a double tap or a retry is the same payment.
 *
 * `pendingApproval` is true above the hostel's cash threshold: the money is
 * recorded but a different staff member has to confirm it.
 */
export async function recordCashPayment(
  invoiceId: string,
  input: {
    amount: number;
    cashReceiptNumber: string;
    collectedBy: string;
    note?: string;
    receivedAt?: string;
  },
) {
  const response = await api.post<ApiEnvelope<{ pendingApproval: boolean }>>(
    `/hostel-admin/finance/invoices/${invoiceId}/cash`,
    input,
  );

  return unwrap(response);
}

/**
 * Reverses an invoice. The reason is mandatory (3–500) and is **shown to the
 * resident verbatim** — a reversal they cannot explain is the same support
 * disaster as one they were never told about.
 */
export async function voidInvoice(invoiceId: string, reason: string) {
  await api.post(`/hostel-admin/finance/invoices/${invoiceId}/void`, {
    reason,
  });
}

export type ResidentLedger = {
  months: {
    dueAmount: number;
    dueDate: string | null;
    invoiceId: string | null;
    paidAmount: number;
    payments: {
      amount: number;
      method: string;
      /** When the money moved per the provider — not when we heard about it. */
      occurredAt: string;
      receiptNumber: string | null;
      settledAt: string | null;
      transactionCode: string | null;
    }[];
    period: string;
    status: string;
  }[];
  resident: {
    fullName: string;
    id: string;
    moveInDate: string | null;
    phone: string | null;
    roomType: string | null;
  };
  totals: {
    monthsBilled: number;
    monthsPaid: number;
    outstanding: number;
    paid: number;
  };
};

/**
 * `GET /hostel-admin/finance/residents/{id}/ledger` — one person's whole
 * payment history, month by month from move-in to now.
 *
 * The envelope's `data` **is** the ledger. This used to read
 * `unwrap(response).ledger`, which is what the neighbouring routes look like
 * ({@link getResident} genuinely returns `{ resident }`) — but this route hands
 * `successResponse` the ledger itself, so that read was `undefined` and every
 * caller would have crashed on `.totals`. Nothing called it yet, which is why
 * nothing had noticed.
 *
 * Needs the `viewPayments` capability, so a warden without it gets a 403 —
 * callers that show this beside non-money facts should catch rather than fail
 * the whole screen.
 */
export async function getResidentLedger(residentId: string) {
  const response = await api.get<ApiEnvelope<ResidentLedger>>(
    `/hostel-admin/finance/residents/${residentId}/ledger`,
  );

  return unwrap(response);
}

/* -------------------------------------------------------------------------- */
/* Statement reconciliation                                                   */
/* -------------------------------------------------------------------------- */

export const STATEMENT_PROVIDERS = ["ESEWA", "KHALTI", "BANK"] as const;

export type StatementProvider = (typeof STATEMENT_PROVIDERS)[number];

export type StatementImport = {
  errorDetail: string | null;
  fileName: string | null;
  matchedCount: number;
  orphanCount: number;
  provider: string;
  rowCount: number;
  statementImportId: string;
  status: string;
  suggestedCount: number;
  uploadedAt: string;
};

export async function listStatementImports() {
  const response = await api.get<ApiEnvelope<{ imports: StatementImport[] }>>(
    "/hostel-admin/finance/statements",
  );

  return unwrap(response).imports;
}

/**
 * Reads an uploaded statement and runs every credit through the matching ladder.
 *
 * Wants `approvePayments`, not `viewPayments`: an import **auto-settles** the
 * rows whose reference codes verify, so it moves money. The asset must be
 * uploaded first, `kind: "STATEMENT"`, and it is checked against this hostel.
 */
export async function importStatement(input: {
  assetId: string;
  provider: StatementProvider;
}) {
  const response = await api.post<ApiEnvelope<StatementImport>>(
    "/hostel-admin/finance/statements",
    input,
  );

  return unwrap(response);
}

/**
 * The three buckets of one import.
 *
 * `matched` is a credit we could tie to an invoice. `orphans` is money that
 * arrived with nothing naming it, each carrying suggestions.
 * `approvedNotInStatement` is the one worth reading twice: **a claim a warden
 * approved that no statement has ever carried.** Payee matching on a screenshot
 * is best-effort, so the only guarantee the product can make is that the money
 * either appears in the account or this row appears instead — and it names the
 * approving warden as well as the resident, because a collusive approval is a
 * fact about two people.
 */
export type ReconciliationView = {
  buckets: {
    approvedNotInStatement: {
      amount: number;
      approvedAt: string | null;
      approvedByName: string | null;
      claimEventId: string;
      period: string | null;
      residentId: string;
      residentName: string;
      transactionCode: string | null;
      why: string;
    }[];
    claimedNoTransaction: {
      amount: number;
      bedLabel: string | null;
      claimEventId: string;
      period: string | null;
      residentName?: string;
      why?: string;
    }[];
    matched: {
      amount: number;
      claimEventId: string | null;
      confirmsClaim: boolean;
      eventId: string;
      occurredAt: string;
      period: string | null;
      providerTxnId: string | null;
      referenceCode: string | null;
      residentName: string;
      status: string;
      why: string;
    }[];
    orphans: {
      amount: number;
      counterpartyName: string | null;
      eventId: string;
      occurredAt: string;
      providerTxnId: string | null;
      remarks: string | null;
      suggestions: {
        confidence: string;
        invoiceId: string;
        residentId: string;
        residentName: string;
        why: string;
      }[];
    }[];
  };
  fileName: string | null;
  matchedTotal: number;
  provider: string;
  rowCount: number;
  statementImportId: string;
  status: string;
  uploadedAt: string;
};

export async function getReconciliation(statementImportId: string) {
  const response = await api.get<ApiEnvelope<ReconciliationView>>(
    `/hostel-admin/finance/statements/${statementImportId}`,
  );

  return unwrap(response);
}

/** Settles every matched row on one import in a single act. */
export async function approveMatchedStatement(statementImportId: string) {
  await api.post(
    `/hostel-admin/finance/statements/${statementImportId}/approve-matched`,
    {},
  );
}

/** Points an orphaned credit at an invoice — the only way that money is claimed. */
export async function assignOrphanPayment(eventId: string, invoiceId: string) {
  await api.post(`/hostel-admin/finance/events/${eventId}/assign`, {
    invoiceId,
  });
}

/* -------------------------------------------------------------------------- */
/* Plan billing — what the hostel pays the platform                           */
/* -------------------------------------------------------------------------- */

/**
 * The hostel's own plan paperwork.
 *
 * Not to be confused with anything in `finance-api.ts`, which is one level down:
 * that is the hostel billing its **residents** for rent, where the hostel is the
 * merchant of record. This is the hostel being billed by **us** for the software
 * it runs on. Different models, different money, different direction — the only
 * thing they share is the word "invoice", which is why the screens are far apart
 * and named differently.
 *
 * ## Read straight off `billing-history.service.ts`
 *
 * Every field below is what that serializer returns, not what the web billing
 * page happens to render — rule 1 at the top of this file. `daysRemaining` in
 * particular is computed on the server on purpose: this screen and the website
 * must never disagree about how many days are left on a plan, and they would the
 * moment each rounded a part-day for itself.
 */
export type PlanBillingInvoice = {
  amount: number;
  currency: string;
  cycleLabel: string;
  /** Always present — a document exists for every invoice now. */
  documentUrl: string;
  dueAt: string | null;
  invoiceNumber: string;
  issuedAt: string | null;
  /** Who printed the page. `platform` while Softmato is unreachable. */
  issuedBy: "softmato" | "platform";
  outstanding: number;
  paid: number;
  planName: string;
  /** What is printed on the owner's copy. Quote this one back to them. */
  printedNumber: string;
  softmatoInvoiceNo: string | null;
  status: string;
};

export type PlanBillingPayment = {
  amount: number;
  /** Null until the payment settles — no receipt for money still in flight. */
  documentUrl: string | null;
  method: string;
  paidAt: string | null;
  printedNumber: string | null;
  provider: string | null;
  providerRef: string | null;
  receiptNumber: string | null;
  softmatoTransactionNo: string | null;
  status: string;
};

export type PlanBillingPlan = {
  /**
   * When the stretch now running began — the day a team hostel was filed (it
   * is live before it has paid), or the day a public one paid.
   */
  activatedAt: string | null;
  /** Still owed on the invoice being paid. `0` when nothing is open. */
  amountDue: number;
  /** Settled so far against that same invoice. */
  amountPaid: number;
  cycleLabel: string | null;
  /**
   * The last instant the plan covers. Null until the plan starts, which is not
   * the same as until it is paid: a team hostel's runs while it still owes.
   */
  currentPeriodEnd: string | null;
  /**
   * Days left on the plan, today included, in Nepal days — so it moves at
   * midnight in Kathmandu and at no other time. Null when nothing is running.
   */
  daysRemaining: number | null;
  /** Nepal days until the day in `dueBy`; 0 on that day. */
  daysToDue: number | null;
  /** The last instant of the day the balance must be paid by. */
  dueBy: string | null;
  /** When the window to pay opened — the open invoice's issue. */
  dueFrom: string | null;
  /**
   * Days the running stretch spans, both ends included — what `daysRemaining`
   * is a share of. Absent from a server that predates it.
   */
  periodDays?: number | null;
  planId: string | null;
  planName: string | null;
  price: number | null;
  status: string;
};

export type PlanBilling = {
  docsUrl: string | null;
  invoices: PlanBillingInvoice[];
  payments: PlanBillingPayment[];
  /** Null for a hostel that predates plan billing. */
  plan: PlanBillingPlan | null;
  subscriptionState?: AdminSubscription | null;
};

export async function getPlanBilling() {
  const response = await api.get<
    ApiEnvelope<{ history: PlanBilling; state: AdminSubscription | null }>
  >("/hostel-admin/billing");

  const { history, state } = unwrap(response);
  return { ...history, subscriptionState: state };
}
