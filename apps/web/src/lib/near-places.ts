import { locationSlug } from "@/lib/hostel-locations";

/**
 * "Hostels near Pulchowk Campus" — which campuses a near page can exist for,
 * and which hostels belong on it.
 *
 * ## Where the facts come from
 *
 * Nothing here is typed by hand. Every hostel with a map pin carries the places
 * around it (`Hostel.nearbyPlaces`, refreshed from Google Places or
 * OpenStreetMap within 1.5 km — `lib/maps/nearby.ts`), each with its own
 * coordinates and its straight-line distance from that hostel's pin. A near
 * page is those rows turned around: one campus, every published hostel that
 * found it nearby, and the distance each one measured.
 *
 * So a campus gets a page only because a real, verified hostel stands within
 * 1.5 km of it, and the page states the distance that hostel's own data says.
 * The curated `NEPAL_COLLEGES` list (the listing's "Near my college" filter)
 * is deliberately not a source: its pins are approximate, and a page that
 * claims a hostel is 400 m from a campus has to be right.
 *
 * ## Which places count
 *
 * The geocoder files colleges, universities *and schools* under one `college`
 * type. Only names that say campus, college, university or institute make a
 * page — "hostels near Pulchowk Campus" is a search; "hostels near Shree
 * Secondary School" is not, and a page per school is the doorway-page pattern
 * search engines penalise. Spelling variants of one name merge by slug.
 */

/** The radius `fetchNearbyPlaces` searches, so pages can say it out loud. */
export const NEAR_RADIUS_METERS = 1500;

const CAMPUS = /\b(campus|college|university|institute|vidyapith|vidhyapith|vidyapeeth)\b/i;
const SCHOOL_ONLY = /\b(school|montessori|kindergarten|pre-?school|boarding)\b/i;

export function isCampusName(name: string) {
  const clean = name.trim();

  if (clean.length < 4 || !CAMPUS.test(clean)) return false;
  // "… Secondary School and College" is a college too; "… Boarding School" is not.
  return !SCHOOL_ONLY.test(clean) || /\b(college|campus)\b/i.test(clean);
}

export type NearPlaceSourceRow = {
  area?: string | null;
  city?: string | null;
  hostelId: string;
  nearbyPlaces: Array<{
    coordinates?: { lat?: number | null; lng?: number | null } | null;
    distance?: number | null;
    name?: string | null;
    type?: string | null;
  }>;
};

export type NearPlace = {
  /** Areas the hostels near it are listed in, most common first. */
  areas: string[];
  city: string;
  coordinates: { lat: number; lng: number } | null;
  /** Hostel id → metres from that hostel's pin, as its own data measured it. */
  distances: Map<string, number>;
  name: string;
  slug: string;
};

function mostCommon(values: string[]) {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value);
}

/**
 * Every campus at least one hostel found nearby, merged by slug, most hostels
 * first. A hostel counts once per campus, at its shortest measured distance.
 */
export function buildNearPlaceIndex(rows: NearPlaceSourceRow[]): NearPlace[] {
  const bySlug = new Map<
    string,
    {
      areas: string[];
      cities: string[];
      coordinates: { lat: number; lng: number } | null;
      distances: Map<string, number>;
      names: string[];
    }
  >();

  for (const row of rows) {
    for (const place of row.nearbyPlaces) {
      const name = place.name?.replace(/\s+/g, " ").trim() ?? "";

      if (place.type !== "college" || !isCampusName(name)) continue;

      const slug = locationSlug(name);
      const distance = place.distance;
      if (!slug || typeof distance !== "number" || distance < 0 || distance > NEAR_RADIUS_METERS) {
        continue;
      }

      const entry = bySlug.get(slug) ?? {
        areas: [],
        cities: [],
        coordinates: null,
        distances: new Map<string, number>(),
        names: [],
      };

      entry.names.push(name);
      if (row.city) entry.cities.push(row.city.trim());
      if (row.area) entry.areas.push(row.area.trim());
      if (!entry.coordinates && place.coordinates?.lat != null && place.coordinates?.lng != null) {
        entry.coordinates = { lat: place.coordinates.lat, lng: place.coordinates.lng };
      }

      const previous = entry.distances.get(row.hostelId);
      if (previous === undefined || distance < previous) {
        entry.distances.set(row.hostelId, Math.round(distance));
      }

      bySlug.set(slug, entry);
    }
  }

  return [...bySlug.entries()]
    .map(([slug, entry]) => ({
      areas: mostCommon(entry.areas),
      city: mostCommon(entry.cities)[0] ?? "",
      coordinates: entry.coordinates,
      distances: entry.distances,
      name: mostCommon(entry.names)[0] ?? slug,
      slug,
    }))
    .sort((a, b) => b.distances.size - a.distances.size || a.name.localeCompare(b.name));
}

/** "350 m", "1.2 km" — straight line, rounded the way people say it. */
export function formatDistance(meters: number) {
  if (meters < 1000) return `${Math.max(50, Math.round(meters / 50) * 50)} m`;
  return `${(Math.round(meters / 100) / 10).toFixed(1)} km`;
}
