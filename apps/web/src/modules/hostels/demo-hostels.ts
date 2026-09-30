import { Types } from "mongoose";
import type { z } from "zod";

import type { publicHostelListQuerySchema } from "@/modules/hostels/hostel.validation";

import json from "./demo-hostels.json";

type PublicHostelListQuery = z.infer<typeof publicHostelListQuerySchema>;

/**
 * Sample listings that live in `demo-hostels.json`, never in the database.
 *
 * They are merged into the public listing, the hostel page and compare, look
 * like any other hostel, and cannot be booked or enquired about. **To remove
 * them all, replace the JSON file's contents with `[]` and redeploy** — nothing
 * else reads the file, and nothing was ever written anywhere.
 *
 * Kept out of the sitemap and the `/hostels/in/...` location pages, and their
 * own pages are `noindex`, so search engines never index a listing that does
 * not exist.
 */

/** Spelled out, so the file still type-checks once it is emptied to `[]`. */
type DemoRow = {
  _id: string;
  capacitySummary: { totalBeds: number; totalRooms: number; vacantBeds: number };
  description: string;
  facilities: string[];
  food: { hasNonVeg: boolean; hasVeg: boolean; mealsPerDay: number };
  hostelType: "BOYS" | "GIRLS" | "CO_LIVING";
  location: { address: string; area: string; city: string; lat: number; lng: number; province: string };
  name: string;
  photos: Array<{ alt: string; kind: "EXTERIOR" | "INTERIOR" | "ROOM"; roomType?: string; url: string }>;
  pricing: { admissionFee: number; currency: string; monthlyRentMax: number; monthlyRentMin: number };
  rating: { averageRating: number; cleanlinessRating: number; foodRating: number; safetyRating: number; total: number };
  roomConfigurations: Array<{
    bedsPerRoom: number;
    mealInclusion: "Included" | "Not Included" | "Optional";
    monthlyRent: number;
    roomType: string;
    rooms: number;
    vacantBeds: number;
  }>;
  roomTypes: string[];
  rules: string[];
  shortStays: { enabled: boolean; minNights: number; rates: Array<{ dailyRate: number; roomType: string }> };
  slug: string;
};

const rows = json as DemoRow[];

/** Shaped as `HostelRecord` so the public serializers treat it like a real row. */
export const demoHostels = rows.map(({ _id, ...row }) => ({
  ...row,
  _id: new Types.ObjectId(_id),
  isDemoData: true,
  ownerId: new Types.ObjectId(_id),
  status: "PUBLISHED" as const,
  verificationStatus: "VERIFIED" as const,
}));

const ratingById = new Map(rows.map((row) => [row._id, row.rating]));
const ids = new Set(rows.map((row) => row._id));

export function isDemoHostelId(id: string) {
  return ids.has(id);
}

export function demoRating(id: string) {
  return ratingById.get(id);
}

/** By slug or id — the same two references the public routes accept. */
export function findDemoHostel(ref: string) {
  return demoHostels.find((hostel) => hostel.slug === ref || hostel._id.toString() === ref);
}

const has = (value: string | undefined, wanted: string) =>
  (value ?? "").toLowerCase().includes(wanted.toLowerCase());

/** The same filter `listPublicHostels` sends Mongo, applied to the sample rows. */
export function demoHostelsMatching(query: PublicHostelListQuery) {
  const facilities = (query.facility ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);

  return demoHostels.filter(
    (hostel) =>
      (!query.q || has(hostel.name, query.q) || has(hostel.location.area, query.q)) &&
      (!query.area || has(hostel.location.area, query.area)) &&
      (!query.city || hostel.location.city.toLowerCase() === query.city.toLowerCase()) &&
      (!query.type || hostel.hostelType === query.type) &&
      facilities.every((facility) => hostel.facilities.includes(facility)) &&
      (query.food !== "veg" || hostel.food.hasVeg) &&
      (query.food !== "non-veg" || hostel.food.hasNonVeg) &&
      (!query.roomType || hostel.roomTypes.includes(query.roomType)) &&
      (query.minPrice === undefined || hostel.pricing.monthlyRentMax >= query.minPrice) &&
      (query.maxPrice === undefined || hostel.pricing.monthlyRentMin <= query.maxPrice) &&
      (query.stay !== "short" || hostel.shortStays.enabled),
  );
}
