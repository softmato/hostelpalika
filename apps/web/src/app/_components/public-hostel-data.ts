import type { PublicBranch } from "@hostel/shared/types/public-branch";
import type { HostelSummary } from "@/app/_components/public-hostel-types";
import { resolveHostelPhotoUrls } from "@/lib/hostel-photos";
import type { NearbyPlaceType } from "@/lib/maps/types";

export const DEFAULT_HOSTEL_IMAGE =
  "https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?auto=format&fit=crop&w=1400&q=80";

export type PublicHostel = {
  otherBranches?: PublicBranch[];
  capacitySummary?: {
    totalBeds?: number;
    totalRooms?: number;
    vacantBeds?: number;
  };
  comparison?: {
    foodScore?: number;
    locationText?: string;
    monthlyFee?: {
      currency?: string;
      max?: number;
      min?: number;
    };
    ratingSummary?: {
      averageRating?: number;
      total?: number;
    };
    vacancy?: number;
  };
  contact?: {
    email?: string;
    phone?: string;
  };
  coordinates?: { lat: number; lng: number } | null;
  description?: string;
  facilities: string[];
  food?: {
    hasNonVeg?: boolean;
    hasVeg?: boolean;
    mealsPerDay?: number;
    notes?: string;
  };
  /** The hostel's weekly routine — it repeats, so it carries no dates. */
  foodRoutine?: {
    meals: Array<{
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
    }>;
    monthEndSpecial?: { items: string[]; note: string } | null;
  };
  hostelType: "BOYS" | "GIRLS" | "CO_LIVING";
  id: string;
  /** A sample listing from `demo-hostels.json` — shown, never indexed or booked. */
  isDemoData?: boolean;
  location: {
    address?: string;
    area: string;
    city?: string;
    /** "Opposite the campus gate" — how directions are actually given here. */
    landmark?: string;
    /** The owner's own maps link, stored as they pasted it. */
    mapLink?: string;
    province?: string;
  };
  name: string;
  nearbyPlaces?: Array<{
    coordinates: { lat: number; lng: number };
    distance: number;
    name: string;
    type: NearbyPlaceType;
  }>;
  photos: Array<{
    alt?: string;
    id?: string;
    kind?: "EXTERIOR" | "INTERIOR" | "ROOM";
    /** Set only on ROOM photos — matches roomConfigurations[].roomType. */
    roomType?: string;
    url?: string;
  }>;
  pricing?: {
    admissionFee?: number;
    formFee?: number;
    currency?: string;
    monthlyRentMax?: number;
    monthlyRentMin?: number;
  };
  roomConfigurations?: Array<{
    bedsPerRoom: number;
    id?: string;
    mealInclusion: "Included" | "Not Included" | "Optional";
    monthlyRent: number;
    rooms: number;
    roomType: string;
    vacantBeds: number;
  }>;
  /** The listing and detail endpoints send it here; compare also nests it in `comparison`. */
  ratingSummary?: {
    averageRating?: number;
    total?: number;
  };
  roomTypes: string[];
  rules: string[];
  slug: string;
  verificationStatus: "UNVERIFIED" | "PENDING" | "VERIFIED" | "REJECTED";
};

export function hostelTypeToUi(type: PublicHostel["hostelType"]): HostelSummary["type"] {
  if (type === "BOYS") {
    return "boys";
  }

  if (type === "GIRLS") {
    return "girls";
  }

  return "co-living";
}

export function formatHostelAddress(hostel: PublicHostel) {
  return (
    hostel.comparison?.locationText ||
    [hostel.location.address, hostel.location.area, hostel.location.city]
      .filter(Boolean)
      .join(", ")
  );
}

export function hasFood(hostel: PublicHostel) {
  return Boolean(
    hostel.food?.mealsPerDay ||
    hostel.food?.hasVeg ||
    hostel.food?.hasNonVeg ||
    hostel.facilities.some((facility) => /food|meal|mess/i.test(facility)),
  );
}

export function mapPublicHostelToSummary(hostel: PublicHostel): HostelSummary {
  return {
    address: formatHostelAddress(hostel),
    area: hostel.location.area,
    city: hostel.location.city ?? "Kathmandu",
    description: hostel.description ?? "",
    facilities: hostel.facilities,
    foodScore: hostel.comparison?.foodScore ?? 0,
    id: hostel.id,
    // The card is the hostel's first look, so an exterior shot leads.
    image: resolveHostelPhotoUrls(hostel.photos, "EXTERIOR")[0] ?? DEFAULT_HOSTEL_IMAGE,
    name: hostel.name,
    owner: "Verified hostel",
    price:
      hostel.comparison?.monthlyFee?.min ??
      hostel.pricing?.monthlyRentMin ??
      hostel.pricing?.monthlyRentMax ??
      0,
    rating:
      Math.round(
        (hostel.comparison?.ratingSummary?.averageRating ??
          hostel.ratingSummary?.averageRating ??
          0) * 10,
      ) / 10,
    reviews: hostel.comparison?.ratingSummary?.total ?? hostel.ratingSummary?.total ?? 0,
    roomTypes: hostel.roomTypes,
    slug: hostel.slug,
    status: "published",
    type: hostelTypeToUi(hostel.hostelType),
    vacancy: hostel.comparison?.vacancy ?? hostel.capacitySummary?.vacantBeds ?? 0,
    verified: hostel.verificationStatus === "VERIFIED",
  };
}

export function roomTypeLabel(roomType: string) {
  return roomType
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .toLowerCase()
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
