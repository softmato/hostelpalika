/**
 * Deriving the home screen's sections from the one listing payload it already
 * holds.
 *
 * `/public/hostels` returns the first 60 rows, cheapest-first, with no
 * pagination — so every row on the home screen is a *slice of one request*
 * rather than a round trip per heading. That is what keeps a screen with six
 * carousels to a single fetch, and it is also the honest limit on all of it: the
 * counts below describe what came back, not the whole database.
 *
 * These live in `lib/` so they can be tested. Vitest runs node-side with no
 * React Native shim, so anything that imports `react-native` is untestable by
 * construction, and the grouping is the part worth a test — a city that appears
 * under two spellings, or a showcase that leads with a hostel that has no photo.
 *
 * This file replaced `home-stats.ts`, which computed the mockup's "500+ Verified
 * Hostels" band from real figures. The band is gone: the home screen is a
 * listings screen, and a row of platform statistics is furniture, however true
 * the numbers were.
 */

import { coverPhoto } from "@/lib/hostel-display";
import type { PublicHostel } from "@/lib/public-api";

export type CitySummary = {
  city: string;
  count: number;
};

/**
 * Cities, busiest first, with how many listings each has.
 *
 * Falls back to `area` when a hostel has no city, because the address is
 * required server-side and the city field is not — dropping those would hide
 * real listings from a section whose whole job is to lead people to them.
 *
 * Grouped case-insensitively so "kathmandu" and "Kathmandu" are one row, and the
 * **first spelling seen wins** as the label: the payload is cheapest-first, so
 * this is stable across renders of the same response rather than a coin flip
 * between two capitalisations.
 *
 * Ties break alphabetically. Sorting by count alone would let two equal cities
 * swap places between two fetches of identical data, which reads as the list
 * flickering.
 */
export function cityCounts(hostels: PublicHostel[]): CitySummary[] {
  const found = new Map<string, CitySummary>();

  for (const hostel of hostels) {
    const name = (hostel.location.city || hostel.location.area || "").trim();

    if (!name) {
      continue;
    }

    const key = name.toLowerCase();
    const existing = found.get(key);

    if (existing) {
      existing.count += 1;
    } else {
      found.set(key, { city: name, count: 1 });
    }
  }

  return [...found.values()].sort(
    (a, b) => b.count - a.count || a.city.localeCompare(b.city),
  );
}

/**
 * The hostels the auto-sliding showcase carries, best first.
 *
 * ## A photo ranks a hostel; it no longer excludes one
 *
 * This filtered to listings that had a cover photo, on the grounds that a grey
 * placeholder at 200px tall was the most prominent thing on the screen. The card
 * is no longer that card — it is a short, wide split where the picture is under
 * half the width — and the filter had a worse cost: a catalogue where one hostel
 * has a photo produced a one-card carousel, so it never slid and the position
 * dots never appeared. A photo now sorts a listing to the front instead, which
 * keeps the good pictures first without emptying the row.
 *
 * Then verified listings, then the best rated. An unreviewed hostel sorts below
 * a rated one rather than being excluded, and `total` — not `averageRating` —
 * decides whether a hostel counts as rated, because every average is `0` before
 * the first review.
 */
export function showcaseHostels(hostels: PublicHostel[], limit = 6): PublicHostel[] {
  return [...hostels]
    .sort((a, b) => {
      // Sample listings from demo-hostels.json always come after real hostels.
      const demo = Number(a.isDemoData) - Number(b.isDemoData);

      if (demo !== 0) {
        return demo;
      }

      const pictured =
        Number(coverPhoto(b.photos) !== null) - Number(coverPhoto(a.photos) !== null);

      if (pictured !== 0) {
        return pictured;
      }

      const verified =
        Number(b.verificationStatus === "VERIFIED") -
        Number(a.verificationStatus === "VERIFIED");

      if (verified !== 0) {
        return verified;
      }

      const rated = Number(b.ratingSummary.total > 0) - Number(a.ratingSummary.total > 0);

      if (rated !== 0) {
        return rated;
      }

      return b.ratingSummary.averageRating - a.ratingSummary.averageRating;
    })
    .slice(0, limit);
}

/**
 * The cities the "Popular Cities" row shows, and how many listings each has.
 *
 * ## The row is configured, not derived
 *
 * It used to be `cityCounts` — whatever cities happened to appear in the first
 * 60 listings. That makes the row a mirror of the catalogue rather than a way
 * into it: a platform launching in Pokhara has no Pokhara card until somebody
 * has already listed there. The order now comes from the superadmin's
 * **Website Config → Locations** page (`locationsSchema`, the same list that
 * fills the public search filters), so the cities the business is opening in are
 * on the home screen before the first hostel registers.
 *
 * **A configured city with no listings still gets a card, showing `0`.** That is
 * the honest version: the card opens onto a browse screen that will say the same
 * thing, and a row that silently drops the empty ones is a row that changes shape
 * as hostels come and go.
 *
 * ## Cities nobody configured are still reachable
 *
 * Any city that has listings but is missing from the config is appended after
 * the configured ones rather than hidden — otherwise a hostel in an unlisted
 * city would be unreachable from this screen the moment somebody forgot to add
 * it upstairs.
 *
 * ## Matching is exact-but-case-insensitive, on purpose
 *
 * The same key `cityCounts` groups by and `inCity` filters on. A looser match
 * here — folding "Chitwan" into "Bharatpur", say — would make the count on the
 * card disagree with the results behind it, which is the one thing these two
 * must never do.
 */
export function featuredCities(
  configured: string[],
  hostels: PublicHostel[],
  limit = 8,
): CitySummary[] {
  const counted = cityCounts(hostels);
  const byKey = new Map(counted.map((row) => [row.city.trim().toLowerCase(), row]));
  const taken = new Set<string>();
  const featured: CitySummary[] = [];

  for (const name of configured) {
    const city = name.trim();
    const key = city.toLowerCase();

    if (!city || taken.has(key)) {
      continue;
    }

    taken.add(key);
    // The configured spelling is the label, and the payload's count is the
    // number — so an admin who writes "Kathmandu" gets "Kathmandu" on the card
    // even where the listings say "kathmandu".
    featured.push({ city, count: byKey.get(key)?.count ?? 0 });
  }

  for (const row of counted) {
    if (!taken.has(row.city.trim().toLowerCase())) {
      featured.push(row);
    }
  }

  return featured.slice(0, limit);
}

/**
 * The best-reviewed listings, and **only** the ones anybody has reviewed.
 *
 * ## Why this earns a row when the others did not
 *
 * Six carousels were cut from this screen because they were slices of one
 * payload under headings that did not mean anything — "Popular right now" and
 * "Newly listed" held the same hostels. This one is a different set, not a
 * different order: an unrated hostel **cannot** appear here, so the row answers
 * a question the showcase above it does not — "what have other students
 * actually rated well" — and on a catalogue where nobody has reviewed anything
 * it is empty and the caller draws no heading at all.
 *
 * ## `total`, never `averageRating`, decides who is in it
 *
 * Every average comes back `0` before the first review, so filtering on the
 * average would silently keep unrated hostels and sort them last — a "Top Rated"
 * row padded out with hostels that have no rating. Ties break on the number of
 * reviews and then on the name: 4.8 from 40 people outranks 4.8 from one, and
 * two identical hostels do not swap places between two fetches of the same data.
 */
export function topRatedHostels(hostels: PublicHostel[], limit = 6): PublicHostel[] {
  return hostels
    .filter((hostel) => hostel.ratingSummary.total > 0)
    .sort(
      (a, b) =>
        Number(a.isDemoData) - Number(b.isDemoData) ||
        b.ratingSummary.averageRating - a.ratingSummary.averageRating ||
        b.ratingSummary.total - a.ratingSummary.total ||
        a.name.localeCompare(b.name),
    )
    .slice(0, limit);
}

/**
 * Hostels with a bed free, in the order the server sent them — cheapest first.
 *
 * ## Why this is a section and not a filter chip
 *
 * It is the one question every other row on this screen ducks. Top Picks ranks,
 * Popular Cities groups, Nearby measures, Top Rated scores — all of them will
 * happily lead somebody to a hostel that is full, and finding that out is a
 * phone call or a visit, not a tap. A full hostel drops out of this row
 * entirely, which is why it is worth a heading.
 *
 * ## `vacantBeds` is read strictly
 *
 * `undefined` is "this hostel has not published its capacity" and `0` is
 * "full" — neither belongs here, and both are common enough that `?? 0` doing
 * the work of both is the point. The number itself is on the card
 * (`showVacancy`), so the row's promise is checkable rather than implied.
 *
 * The payload's own order is kept rather than sorting by how many beds are free:
 * cheapest-first is what a student is scanning for, and "most vacant" would put
 * the emptiest hostel first, which is not a recommendation.
 */
export function withVacantBeds(hostels: PublicHostel[], limit = 6): PublicHostel[] {
  return hostels
    .filter((hostel) => (hostel.capacitySummary.vacantBeds ?? 0) > 0)
    .slice(0, limit);
}

/**
 * Narrows a list to hostels that actually feed their residents.
 *
 * **Client-side, for the same reason `inCity` is.** The server's
 * `publicHostelListQuerySchema` has a `food` filter, but it takes `veg` /
 * `non-veg` — it answers "what kind of food", not "is there any", and sending
 * `food=veg` for the home screen's Food tile would quietly drop every hostel
 * with a non-vegetarian kitchen. `mealsPerDay` is already in the payload and is
 * the field that means what the tile says.
 */
export function servingMeals(hostels: PublicHostel[]): PublicHostel[] {
  return hostels.filter((hostel) => (hostel.food?.mealsPerDay ?? 0) > 0);
}

/**
 * Narrows a list to one city, matching `cityCounts`' grouping.
 *
 * **Client-side, and it says so at the call site.** The server's
 * `publicHostelListQuerySchema` has an `area` filter that matches
 * `location.area` only — a hostel in "Ghattekulo, Kathmandu" does not match
 * `?area=Kathmandu` — and no `city` filter at all. This narrows the rows already
 * returned, which is the same trade `Sort: nearest` makes on the browse screen:
 * it genuinely changes what is on screen, and it does not pretend to have
 * narrowed the query. Within the 60-row window the count on the home screen and
 * the results here are computed from the same payload, so they agree.
 */
export function inCity(hostels: PublicHostel[], city: string): PublicHostel[] {
  const wanted = city.trim().toLowerCase();

  if (!wanted) {
    return hostels;
  }

  return hostels.filter((hostel) => {
    const name = (hostel.location.city || hostel.location.area || "").trim();

    return name.toLowerCase() === wanted;
  });
}
