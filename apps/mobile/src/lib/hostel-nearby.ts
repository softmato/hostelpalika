/**
 * Grouping the places around a hostel, the way the website's Location panel
 * groups them.
 *
 * Pure and free of React Native imports so it can be tested node-side, and so
 * `components/hostel-map.tsx` can reach `nearbyGlyph` from inside the string it
 * builds for the WebView.
 *
 * ## The order is a judgement, not an alphabet
 *
 * Ported from `NEARBY_GROUPS` in `public-hostel-detail-page.tsx`, in the same
 * order: colleges, hospitals, pharmacies, bus stops, restaurants, parks, gyms.
 * That order is roughly "what decides whether you take the room" — a student
 * picks a hostel by how far the campus is and worries about the gym later — and
 * on a phone it matters more than on the web, because the reader sees the first
 * two groups and scrolls for the rest.
 *
 * ## Types outside the table are kept, not dropped
 *
 * The server's `type` is a free string from the cached OpenStreetMap lookup
 * (`lib/maps/nearby.ts`), so it can carry a category this table has never heard
 * of. Those land in a trailing group named from the type itself rather than
 * being discarded: a hostel next door to something useful should not lose it
 * because the client's list is a version behind the geocoder's.
 */

import type { NearbyPlace } from "@/lib/public-api";

/**
 * A glyph per category, for the map's place dots.
 *
 * Emoji rather than an icon font, and this is the one place in the app that uses
 * them. The dots are drawn inside the Leaflet WebView, which is a plain HTML
 * page with no access to the `<Glyph>` components the rest of the app draws — the
 * alternatives were inlining an SVG path per category into the generated string,
 * or shipping a font file to a page that already needs a network for its tiles.
 * A 9px emoji in a 16px circle is legible on both platforms and costs nothing.
 */
const NEARBY_GLYPHS: Record<string, string> = {
  bus_stop: "🚌",
  college: "🎓",
  gym: "🏋",
  hospital: "🏥",
  park: "🌳",
  pharmacy: "💊",
  restaurant: "🍽",
};

export function nearbyGlyph(type: string): string {
  return NEARBY_GLYPHS[type] ?? "📍";
}

/** Glyph name per category, for the list under the map. */
const NEARBY_ICONS: Record<string, string> = {
  bus_stop: "bus",
  college: "school",
  gym: "barbell",
  hospital: "medkit",
  park: "leaf",
  pharmacy: "medical",
  restaurant: "restaurant",
};

export function nearbyIcon(type: string): string {
  return NEARBY_ICONS[type] ?? "location";
}

/** The website's order and its labels, to the word. */
const NEARBY_GROUPS = [
  { label: "Colleges & schools", type: "college" },
  { label: "Hospitals & clinics", type: "hospital" },
  { label: "Pharmacies", type: "pharmacy" },
  { label: "Bus stops", type: "bus_stop" },
  { label: "Restaurants & cafes", type: "restaurant" },
  { label: "Parks", type: "park" },
  { label: "Gyms", type: "gym" },
] as const;

export type NearbyGroup = {
  icon: string;
  label: string;
  places: NearbyPlace[];
  type: string;
};

/**
 * `nearbyPlaces` folded into the known categories, nearest first within each,
 * with empty categories dropped.
 *
 * Empty groups are dropped rather than shown at zero because the alternative is
 * seven headings on every hostel and a reader learning nothing from six of them
 * — the same rule the detail screen applies to every other section.
 */
export function groupNearbyPlaces(places: readonly NearbyPlace[]): NearbyGroup[] {
  const byType = new Map<string, NearbyPlace[]>();

  for (const place of places) {
    const existing = byType.get(place.type);

    if (existing) {
      existing.push(place);
    } else {
      byType.set(place.type, [place]);
    }
  }

  const known = NEARBY_GROUPS.flatMap((group) => {
    const found = byType.get(group.type);
    byType.delete(group.type);

    return found
      ? [
          {
            icon: nearbyIcon(group.type),
            label: group.label,
            places: sortByDistance(found),
            type: group.type,
          },
        ]
      : [];
  });

  /*
   * Whatever the geocoder returned that this table does not name. `Map`
   * preserves insertion order, so these come out in the order the server sent
   * them — which is the only ordering available and is at least stable between
   * two reads of the same hostel.
   */
  const unknown = Array.from(byType, ([type, found]) => ({
    icon: nearbyIcon(type),
    label: humanizeNearbyType(type),
    places: sortByDistance(found),
    type,
  }));

  return [...known, ...unknown];
}

/** `bus_stop` → `Bus stop`. Only reached for a category not in the table. */
export function humanizeNearbyType(type: string): string {
  const words = type.replace(/[_-]+/g, " ").trim().toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

function sortByDistance(places: NearbyPlace[]): NearbyPlace[] {
  return [...places].sort((a, b) => a.distance - b.distance);
}
