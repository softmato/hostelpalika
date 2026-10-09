/**
 * The cook portal: announce a meal, and — as of the M7 server work — actually
 * see what that meal is.
 *
 * ## What changed on the server
 *
 * Until M7 the cook had exactly one endpoint, `POST /cook/food-ready`. The menu
 * and head count they needed sat under `hostel-admin/food/*` behind
 * `requireHostelCapability("manageFood")`, which resolves to HOSTEL_ADMIN or
 * WARDEN — so the person cooking the meal could announce it and not look it up.
 * That was server gap #3. `GET /cook/today`, `GET /cook/residents` and
 * `POST /cook/food-photos` close it, gated on the same role list the announce
 * route already used.
 *
 * ## One account per hostel, and what follows from that
 *
 * `provisionCookAccount` creates a single shared kitchen login per hostel, with
 * a password the admin can also use until it is replaced. Two consequences the
 * screens depend on:
 *
 *  - **Attribution is by device, not by user.** `deviceInfo` on the announce
 *    call is the only record of *which* phone in the kitchen sent it, which is
 *    why `lib/device-info.ts` is attached to every announcement.
 *  - **`GET /cook/residents` is the thinnest list in the product** — name and
 *    room type, nothing contactable — because a shared, static credential is
 *    the one most likely to leak.
 */

import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import type { FoodRoutine, MealType, RoutineMeal } from "@/lib/resident-api";

/* -------------------------------------------------------------------------- */
/* Today                                                                      */
/* -------------------------------------------------------------------------- */

export type FoodReadyAnnouncement = {
  announcedAt: string;
  /**
   * Who called it, resolved through the hostel's cook roster rather than joined
   * to the account's name.
   *
   * A cook who has left reads as `Previous Sunrise cook` — the label frozen
   * when they were removed — because their account is gone and the name of
   * whoever holds the kitchen login *now* would be a lie about who cooked in
   * Bhadra. Empty for announcements made before the roster existed, and
   * **absent entirely** from `/cook/today`, which lists today's announcements
   * so the four meal buttons can show `Sent 12:04` — who called it is not that
   * list's question. Only the history on More asks it.
   */
  announcedBy?: string;
  id: string;
  mealType: string;
  message: string;
  /** How many residents the fan-out actually reached. */
  notifiedCount: number;
};

export type CookToday = {
  /** Today's announcements only — what the four buttons should already show. */
  announced: FoodReadyAnnouncement[];
  /** `YYYY-MM-DD`, from the server's clock rather than the phone's. */
  date: string;
  hostel: {
    id: string;
    name: string;
    /**
     * The public listing's slug, or `""` when there is no live page — the
     * server sends nothing unless the hostel is PUBLISHED **and** VERIFIED, so
     * the header's eye is withheld rather than pointed at a 404.
     */
    slug: string;
  };
  /** Today's weekday entries off the routine, in meal order. */
  meals: RoutineMeal[];
  /** Active residents. The same count the announcement fan-out notifies. */
  residentCount: number;
  /** The whole week, so the Menu tab needs no second request. */
  routine: FoodRoutine;
  /**
   * The owner let the kitchen add what it spends (docs/EXPENSES_PLAN.md).
   * Optional: an older server does not send it, and absent reads as off.
   */
  expensesEnabled?: boolean;
  /** Shows *Kitchen stock*: the owner allows it and the store has items. Absent reads as off. */
  stockEnabled?: boolean;
};

export async function getCookToday() {
  const response = await api.get<ApiEnvelope<{ today: CookToday }>>("/cook/today");

  return unwrap(response).today;
}

/* -------------------------------------------------------------------------- */
/* Residents                                                                  */
/* -------------------------------------------------------------------------- */

/** Deliberately three fields. See the header — there is nothing to contact. */
export type CookResident = { fullName: string; id: string; roomType: string };

export async function listCookResidents() {
  const response =
    await api.get<ApiEnvelope<{ residents: CookResident[] }>>("/cook/residents");

  return unwrap(response).residents;
}

/* -------------------------------------------------------------------------- */
/* Announce                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The announce response, which carries one field the log rows do not.
 *
 * The hostel's own staff — owner, hostel admins, wardens — get their own
 * notification when the kitchen calls a meal, worded for them: the time, the
 * reach and the handset it came from. `staffNotifiedCount` is how many of them
 * were told, and it exists so the cook's toast can say the office knows too.
 * `listFoodReadyLogs` returns plain `FoodReadyAnnouncement` rows, so this is not
 * on the shared type.
 */
export type FoodReadySent = FoodReadyAnnouncement & { staffNotifiedCount: number };

export type FoodReadyResult = { announcement: FoodReadySent };

/**
 * `POST /cook/food-ready`.
 *
 * ## `notifiedCount` is the field that matters
 *
 * A `201` means the announcement was *recorded*. `announcement.notifiedCount` is
 * how many residents it actually reached — and it can be zero for a hostel whose
 * residents have no accounts. A screen that reports success without reading it
 * tells a cook the hostel has been called to dinner when nobody was told.
 *
 * ## The cooldown is a real, expected failure
 *
 * `getOperationsConfig().foodReadyCooldownMinutes` caps how often the same meal
 * can be announced, and a second tap inside that window returns **429** with a
 * message naming the wait in minutes. That is not an error to swallow or retry:
 * it exists because the credential is shared and static, so it is the one guard
 * against a leaked login pushing a notification to every resident repeatedly.
 * Show the server's message.
 *
 * ## `deviceInfo`
 *
 * The only attribution there is. One login serves the whole kitchen, so the
 * device fingerprint is what distinguishes two cooks, and it is registered on
 * the first announcement rather than at sign-in — there is no cook-side
 * registration endpoint, and the announcement is the only event worth tracing.
 */
export async function announceFoodReady(input: {
  deviceInfo?: Record<string, unknown>;
  mealType: MealType;
  /** Omitted → the server builds one from today's menu for that meal. */
  message?: string;
  useMenuDescription?: boolean;
}) {
  const response = await api.post<ApiEnvelope<FoodReadyResult>>("/cook/food-ready", {
    deviceInfo: input.deviceInfo ?? {},
    mealType: input.mealType,
    ...(input.message ? { message: input.message } : {}),
    useMenuDescription: input.useMenuDescription ?? true,
  });

  return unwrap(response).announcement;
}

/** `GET /cook/food-ready` — the last 50 announcements for this hostel. */
export async function listFoodReadyLogs() {
  const response =
    await api.get<ApiEnvelope<{ logs: FoodReadyAnnouncement[] }>>("/cook/food-ready");

  return unwrap(response).logs;
}

/* -------------------------------------------------------------------------- */
/* Photos                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * `POST /cook/food-photos` — the same `foodPhotoUploadSchema` and the same feed
 * the resident and admin routes write to. The asset itself goes through the
 * shared `/files` pipeline first (`lib/uploads.ts`); this only attaches it.
 */
export async function uploadCookFoodPhoto(input: {
  caption?: string;
  date: string;
  mealType: MealType;
  photoAssetId: string;
}) {
  const response = await api.post<ApiEnvelope<{ photo: { id: string } }>>(
    "/cook/food-photos",
    input,
  );

  return unwrap(response).photo;
}

/**
 * One photo in the kitchen's own feed.
 *
 * `source` rather than an uploader id: the cook login is shared kitchen-wide,
 * so the server cannot say *which* cook posted a photo and does not pretend to.
 * What it can say honestly is kitchen or resident, and that is the distinction
 * the screen needs — a resident's photo of their plate is not the kitchen's
 * record of the meal.
 */
export type CookFoodPhoto = {
  caption: string;
  /** The meal's date. Grouping is done server-side; this is for the detail line. */
  date: string;
  id: string;
  mealType: MealType;
  photoAssetId: string;
  source: "KITCHEN" | "RESIDENT";
  /** When it actually reached the server — what "posted 7:41 pm" reads off. */
  uploadedAt: string;
};

export type CookPhotoDay = {
  /** `YYYY-MM-DD` in **Nepal time**, not UTC — see `food-photo-days.ts`. */
  day: string;
  /** Distinct meals covered that day, out of four. Not a photo count. */
  mealsCovered: number;
  photos: CookFoodPhoto[];
};

/**
 * `GET /cook/food-photos` — what this kitchen has posted, newest day first.
 *
 * The read half of the upload route, added 2026-08-18. Until then the route was
 * POST-only: a cook could post a photo of dinner and had no way to see it, or to
 * see whether anyone had posted at all today, while every resident in the hostel
 * could.
 *
 * **Days are grouped by the server**, in `Asia/Kathmandu`. Doing it here would
 * mean the phone's timezone decided which day a meal belonged to, and a cook
 * whose handset is set to anything else would see breakfast filed under
 * yesterday — Nepal is +05:45, so an early meal is the previous UTC day.
 *
 * **It pages, and the page boundary is a keyset rather than an offset.** A page
 * is 120 photos, which is about a fortnight of four meals a day, and a kitchen
 * posting daily loses last month off the bottom without this. `cursor` is the
 * last row's own sort key, so a photo posted while a cook is paging cannot
 * shuffle a row into or out of the next page the way `skip` would.
 */
export type CookPhotoFeed = {
  /**
   * Where the next page starts, or `null` at the end of the feed. Opaque — it
   * is the server's own sort key and is handed straight back, never built here.
   */
  cursor: string | null;
  days: CookPhotoDay[];
  hasMore: boolean;
  total: number;
};

export async function listCookFoodPhotos(cursor?: string) {
  const response = await api.get<ApiEnvelope<CookPhotoFeed>>("/cook/food-photos", {
    ...(cursor ? { params: { cursor } } : {}),
  });

  return unwrap(response);
}
