import { formatAmount } from "@/lib/format";
import type { HostelPhoto, NearbyPlace, PublicHostel, RatingSummary } from "@/lib/public-api";

/**
 * Turning a public hostel payload into the strings a card shows.
 *
 * In `lib/` so it can be tested — Vitest here is node-side with no React Native
 * shim. Every one of these has a branch that is wrong in a way a screenshot
 * would not catch: a price range that reads "NPR 8,000 – 8,000", a brand-new
 * hostel rendered as one star, a distance printed in metres as "3200 km".
 */

/* -------------------------------------------------------------------------- */
/* Price                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * `NPR 7,000` when the hostel has one price, `NPR 7,000 – 9,000` when it has a
 * range, and `—` when it has published neither.
 *
 * Collapsing an equal min/max matters: every hostel with a single room type has
 * `min === max`, so without this the common case reads as a range of one
 * number, which looks like a bug in the listing rather than a fixed price.
 */
export function priceRange(pricing: PublicHostel["pricing"]): string {
  const min = pricing.monthlyRentMin;
  const max = pricing.monthlyRentMax;

  if (!min && !max) {
    return "—";
  }

  const low = min ?? max ?? 0;
  const high = max ?? min ?? 0;

  return low === high
    ? `NPR ${formatAmount(low)}`
    : `NPR ${formatAmount(low)} – ${formatAmount(high)}`;
}

/* -------------------------------------------------------------------------- */
/* Rating                                                                     */
/* -------------------------------------------------------------------------- */

export type RatingDisplay =
  | { count: number; kind: "rated"; value: string }
  | { kind: "new" };

/**
 * **Branches on `total`, never on `averageRating`.**
 *
 * Every average comes back `0` for a hostel nobody has reviewed, and `0` is
 * also something reviews can genuinely average to, so reading the average alone
 * shows a brand-new hostel as one star — worse than showing nothing, because a
 * visitor filters it out and it never recovers.
 *
 * One decimal place: `4.5`, not `4.5238095`.
 */
export function ratingDisplay(summary: RatingSummary | undefined): RatingDisplay {
  if (!summary || summary.total <= 0) {
    return { kind: "new" };
  }

  return {
    count: summary.total,
    kind: "rated",
    value: (Math.round(summary.averageRating * 10) / 10).toFixed(1),
  };
}

/* -------------------------------------------------------------------------- */
/* Photos                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The building, not a bedroom.
 *
 * The server already sorts exterior-first, but a hostel that uploaded only room
 * shots has none — so this falls through to whatever exists rather than
 * rendering an empty card. Returns null only when there are genuinely no
 * photos, which the card shows as a placeholder.
 */
export function coverPhoto(photos: HostelPhoto[]): HostelPhoto | null {
  return photos.find((photo) => photo.kind === "EXTERIOR" && photo.url)
    ?? photos.find((photo) => photo.url)
    ?? null;
}

/**
 * The URL a card should download: the server's 640px copy when it exists, a
 * 640px ask of the demo listings' Pexels photos, else the original. A card is
 * at most ~300dp wide; the full viewer keeps reading `url`.
 */
export function cardPhotoUrl(photo: HostelPhoto | null | undefined): string | undefined {
  if (!photo) return undefined;
  if (photo.mediumUrl) return photo.mediumUrl;
  if (photo.url.startsWith("https://images.pexels.com/")) {
    return photo.url.replace(/([?&])w=\d+/, "$1w=640").replace(/([?&])h=\d+/, "$1h=480");
  }
  return photo.url;
}

/* -------------------------------------------------------------------------- */
/* Distance                                                                   */
/* -------------------------------------------------------------------------- */

/** `nearbyPlaces[].distance` is **metres** — `haversineMeters` in lib/maps/nearby.ts. */
export function formatDistance(metres: number): string {
  if (!Number.isFinite(metres) || metres < 0) {
    return "—";
  }

  if (metres < 1000) {
    // Rounded to 50m: a walking distance quoted to the metre is false precision
    // from a geocoded centroid.
    return `${Math.round(metres / 50) * 50} m`;
  }

  return `${(Math.round(metres / 100) / 10).toFixed(1)} km`;
}

/**
 * The nearest college, which is the distance students actually care about.
 *
 * `nearbyPlaces` is sorted by distance server-side, so the first college in the
 * list is the closest — no second sort here, and no assumption that the overall
 * first entry is a college.
 */
export function nearestCollege(places: NearbyPlace[]): NearbyPlace | null {
  return places.find((place) => place.type === "college") ?? null;
}

/** `3.2 km from Pulchowk Campus`, or null when nothing nearby is a college. */
export function campusDistanceLabel(places: NearbyPlace[]): string | null {
  const college = nearestCollege(places);

  return college ? `${formatDistance(college.distance)} from ${college.name}` : null;
}

/* -------------------------------------------------------------------------- */
/* Location                                                                   */
/* -------------------------------------------------------------------------- */

/** `Ghattekulo, Kathmandu` — the parts that exist, in order, deduplicated. */
export function locationLabel(location: PublicHostel["location"]): string {
  const parts = [location.area, location.city].filter(
    (part): part is string => Boolean(part?.trim()),
  );

  return [...new Set(parts)].join(", ");
}

/** `Vacant 54`, or null when the hostel publishes no capacity. */
export function vacancyLabel(capacity: PublicHostel["capacitySummary"]): string | null {
  const vacant = capacity.vacantBeds;

  // `0` is a real answer — "full" — and must not be hidden the way `undefined`
  // is. A hostel with no beds left is exactly what a searcher needs to know.
  return vacant === undefined || vacant === null ? null : `${vacant} beds vacant`;
}
