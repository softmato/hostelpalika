import type { PublicBranch } from "@hostel/shared/types/public-branch";
/**
 * The public, no-account surface: browse, filter, compare, enquire.
 *
 * Typed from `apps/web/src/modules/hostels/hostel.service.ts` —
 * `serializePublicHostel` and the two Zod query schemas — not from the route
 * names. Reading the route and guessing the payload is what produced a
 * `finance-api.ts` that would have thrown on its first real call.
 *
 * Uses `publicApi`, the interceptor-free client: none of this needs a token,
 * and a 401 from an unrelated expiry must not bounce a signed-out visitor
 * browsing hostels into a login screen.
 *
 * ## What does not exist, and is therefore not here
 *
 * There is no bookings endpoint, no messaging endpoint and no favourites
 * collection anywhere on the server. The discovery mockups show tabs for all
 * three; they are cut until there is something behind them
 * (docs/mockups/mobile/README.md).
 */

import { api, publicApi } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";

/* -------------------------------------------------------------------------- */
/* Vocabulary — mirrors the server's, so a filter chip cannot send a value     */
/* the query schema rejects.                                                  */
/* -------------------------------------------------------------------------- */

export const HOSTEL_TYPES = ["BOYS", "GIRLS", "CO_LIVING"] as const;

export type HostelType = (typeof HOSTEL_TYPES)[number];

export const HOSTEL_TYPE_LABELS: Record<HostelType, string> = {
  BOYS: "Boys",
  CO_LIVING: "Co-living",
  GIRLS: "Girls",
};

/** `lib/search/query-parser.ts` — the only values the filters accept. */
export const ROOM_TYPES = ["Single", "Double", "Triple", "Dormitory"] as const;

export const FACILITIES = [
  "WiFi",
  "Hot water",
  "Parking",
  "Laundry",
  "Gym",
  "Study table",
  "Attached bathroom",
  "AC",
  "CCTV",
  "Power backup",
] as const;

export type Facility = (typeof FACILITIES)[number];

/* -------------------------------------------------------------------------- */
/* Shapes                                                                     */
/* -------------------------------------------------------------------------- */

export type HostelPhoto = {
  alt: string;
  id?: string;
  /** Exterior leads the gallery — the server sorts, the client does not. */
  kind: "EXTERIOR" | "INTERIOR" | "ROOM";
  roomType: string;
  url: string;
};

export type NearbyPlace = {
  coordinates: { lat: number; lng: number };
  /** Metres. `type` is `"college" | "hospital" | "bus_stop" | "park" | …`. */
  distance: number;
  name: string;
  type: string;
};

export type RoomConfiguration = {
  bedsPerRoom: number;
  id?: string;
  mealInclusion: "Included" | "Not Included" | "Optional";
  monthlyRent: number;
  rooms: number;
  roomType: string;
  vacantBeds: number;
};

/**
 * Review averages.
 *
 * **Read `total`, not `averageRating`, to decide whether a hostel is rated.**
 * Every average is `0` for a hostel nobody has reviewed, and `0` is also
 * something reviews can genuinely average to — so a card that branches on the
 * average renders a brand-new hostel as one star. `total === 0` means "New".
 */
export type RatingSummary = {
  averageRating: number;
  cleanlinessRating: number;
  foodRating: number;
  safetyRating: number;
  total: number;
};

export type PublicHostel = {
  capacitySummary: { totalBeds?: number; totalRooms?: number; vacantBeds?: number };
  /** Phone only. The email stays behind the inquiry form. */
  contact: { phone?: string };
  coordinates: { lat: number; lng: number } | null;
  demoDataLabel: string;
  description: string;
  facilities: string[];
  food: { hasNonVeg?: boolean; hasVeg?: boolean; mealsPerDay?: number; notes?: string };
  hostelType: HostelType;
  id: string;
  isDemoData: boolean;
  location: {
    address?: string;
    area: string;
    city?: string;
    lat?: number;
    lng?: number;
    province?: string;
  };
  name: string;
  nearbyPlaces: NearbyPlace[];
  /** "Find the gate": a short note and one photo of the entrance, or null. */
  arrivalGuide?: { note: string; photoUrl: string } | null;
  photos: HostelPhoto[];
  pricing: {
    admissionFee?: number;
    formFee?: number;
    currency?: string;
    monthlyRentMax?: number;
    monthlyRentMin?: number;
  };
  ratingSummary: RatingSummary;
  roomConfigurations: RoomConfiguration[];
  roomTypes: string[];
  rules: string[];
  slug: string;
  verificationStatus: "PENDING" | "REJECTED" | "UNVERIFIED" | "VERIFIED";
};

/** The week's food routine, as the detail and compare endpoints return it. */
export type PublicFoodRoutine = {
  meals: {
    dayOfWeek: string;
    items: string[];
    mealType: string;
    note: string;
    timing: string;
  }[];
  monthEndSpecial: { items: string[]; note: string } | null;
  timings: Record<string, string | undefined>;
  updatedAt: string;
};

/** The listing endpoint drops the routine; the detail endpoint carries it. */
export type PublicHostelDetail = PublicHostel & {
  otherBranches?: PublicBranch[];
  foodRoutine: PublicFoodRoutine;
};

export type ComparedHostel = PublicHostel & {
  foodRoutine: PublicFoodRoutine;
  comparison: {
    facilities: string[];
    foodScore: number;
    locationText: string;
    monthlyFee: { currency: string; max: number; min: number };
    ratingSummary: Omit<RatingSummary, "foodRating">;
    roomTypes: string[];
    vacancy: number;
    verificationStatus: string;
  };
};

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Mirrors `publicHostelListQuerySchema` exactly.
 *
 * Note what is **not** here, because the mockup's filter sheet implies it:
 * there is no `sort`, no `page`, and no multi-select — the server takes one
 * `facility` and one `roomType`, sorts by cheapest-first, and returns the first
 * 60. A UI offering more than that is offering something the server will
 * silently ignore.
 */
export type HostelFilters = {
  area?: string;
  facility?: string;
  food?: "non-veg" | "veg";
  maxPrice?: number;
  minPrice?: number;
  q?: string;
  roomType?: string;
  /** `short` = only hostels that take nightly stays. */
  stay?: "short";
  type?: HostelType;
};

/** Drops empty values so a cleared filter does not become `?area=`. */
function definedParams(filters: HostelFilters) {
  return Object.fromEntries(
    Object.entries(filters).filter(
      ([, value]) => value !== undefined && value !== null && value !== "",
    ),
  );
}

export async function listPublicHostels(filters: HostelFilters = {}) {
  const response = await publicApi.get<ApiEnvelope<{ hostels: PublicHostel[] }>>(
    "/public/hostels",
    { params: definedParams(filters) },
  );

  const hostels = unwrap(response).hostels;

  /*
   * Report the search appearances this list represents.
   *
   * The listing endpoint is CDN-cached, so the server cannot count them any
   * more — a cached response never reaches it. Fire-and-forget and silent on
   * failure: a hostel owner's "Seen in search" figure is never worth failing a
   * browse on. The website does the same thing in `useHostels`.
   */
  const hostelIds = hostels.map((hostel) => hostel.id).filter(Boolean);

  if (hostelIds.length > 0) {
    void publicApi
      .post("/public/hostels/impressions", { hostelIds: hostelIds.slice(0, 60) })
      .catch(() => undefined);
  }

  return hostels;
}

export async function getPublicHostel(slug: string) {
  const response = await publicApi.get<ApiEnvelope<{ hostel: PublicHostelDetail }>>(
    `/public/hostels/${encodeURIComponent(slug)}`,
  );

  return unwrap(response).hostel;
}

/** The server enforces 2–3 ids and rejects the request otherwise. */
export const COMPARE_MIN = 2;
export const COMPARE_MAX = 3;

export async function comparePublicHostels(ids: string[]) {
  const response = await publicApi.get<ApiEnvelope<{ hostels: ComparedHostel[] }>>(
    "/public/hostels/compare",
    { params: { ids: ids.join(",") } },
  );

  return unwrap(response).hostels;
}

/**
 * Mirrors `publicInquiryCreateSchema`. `name` (2–120) and `phone` (7–24) are
 * the only required fields — everything else the hostel would otherwise have to
 * ask for on the phone.
 */
export type InquiryInput = {
  budgetRange?: string;
  email?: string;
  message?: string;
  name: string;
  phone: string;
  preferredRoomType?: string;
};

export async function sendHostelInquiry(slug: string, input: InquiryInput) {
  const response = await publicApi.post<
    ApiEnvelope<{ shouldCollectProfile?: boolean }>
  >(`/public/hostels/${encodeURIComponent(slug)}/inquiries`, input);

  return unwrap(response);
}

/**
 * The same message, sent through a resident's referral code.
 *
 * ## A different endpoint, and a narrower payload
 *
 * `POST /public/inquiries/with-referral` — not the hostel's own inquiry route.
 * `referredInquiryCreateSchema` takes only `name`, `phone`, `email?`,
 * `message?` and `referralCode`: no `budgetRange`, no `preferredRoomType`, and
 * **no hostel**. Sending the extra fields is harmless but pointless; sending a
 * slug is impossible, which is the important part below.
 *
 * ## The code chooses the hostel, not the user
 *
 * `createReferredInquiry` resolves the code to `referralCode.hostelId` and
 * writes the `Inquiry` against that hostel, plus a `Referral` row crediting the
 * referrer. So a referred inquiry is always *the referrer's* hostel, and the app
 * cannot name it beforehand — no public endpoint resolves a code to a hostel.
 * The screen has to be honest about that rather than guessing a name.
 *
 * ## One per phone number per code
 *
 * A second submission with the same phone against the same code is a 409
 * (`REFERRAL_ALREADY_EXISTS`), which is a "we already have this" and reads as
 * such, not as a failure. The route is also rate limited as a public form.
 */
export type ReferredInquiryInput = {
  email?: string;
  message?: string;
  name: string;
  phone: string;
  referralCode: string;
};

export async function sendReferredInquiry(input: ReferredInquiryInput) {
  const response = await publicApi.post<
    ApiEnvelope<{ inquiry: { id: string; status: string } }>
  >("/public/inquiries/with-referral", input);

  return unwrap(response);
}

/**
 * Tells the hostel's staff a signed-in traveller is on the way, and roughly
 * when. Only the minutes and the mode are sent — never a position.
 */
export async function announceArrival(slug: string, minutes: number, mode: "car" | "foot") {
  return unwrap(
    await api.post<ApiEnvelope<{ sent: boolean }>>(
      `/public/hostels/${encodeURIComponent(slug)}/arriving`,
      { minutes, mode },
    ),
  );
}

/** Place search for "My college / office", through our server's geocoder proxy. */
export async function searchPlaces(query: string) {
  const response = await publicApi.get<
    ApiEnvelope<{ places: { lat: number; lng: number; name: string }[] }>
  >("/public/places", { params: { q: query } });

  return unwrap(response).places;
}
