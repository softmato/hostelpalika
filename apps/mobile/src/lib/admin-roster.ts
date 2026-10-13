/**
 * Counting the roster, for the Residents tab's banner.
 *
 * Pure and free of the axios client, same rule as `lib/admin-alerts.ts`,
 * `lib/admin-money.ts` and `lib/admin-home.ts`: Vitest runs node-side with no
 * React Native shim, so anything reaching `lib/api` is untestable by
 * construction.
 */

import type { AdminResident } from "@/lib/admin-api";

export type RosterSummary = {
  /** Living here now. */
  active: number;
  /** Registered, not moved in — the queue that needs an activation code. */
  pending: number;
  /** Everyone the list returned, whatever their state. */
  total: number;
};

/**
 * The roster, split three ways.
 *
 * ## Why `MOVED_OUT` is not a bucket
 *
 * `listAdminResidents` asks for a page of 50 with no status filter, so a hostel
 * with turnover has former residents in the same array as current ones. Counting
 * them would put a number on the banner that grows forever and means nothing —
 * "58 residents" for a hostel with 40 beds. `active` is the figure that answers
 * *how many people live here*, `total` is what the list below is actually
 * showing, and they are both stated so the difference is visible rather than
 * being a discrepancy somebody has to work out.
 *
 * ## Anything unrecognised counts toward neither
 *
 * The server owns this enum — `ACTIVE`, `PENDING`, `MOVED_OUT` today — and a
 * member added later must not be silently folded into `active`, which is the
 * figure a hostel would check against its own beds. It lands in `total` only,
 * where being one short is visible rather than wrong.
 */
export type RosterSegment = "active" | "all" | "pending";

/**
 * The rows one segment of the Residents tab shows.
 *
 * Three views, mutually exclusive, switching a list instantly — which is the
 * case Material 3 reserves segmented buttons for, and why the screen does not
 * use filter chips: chips imply two could be on at once, and "living here" and
 * "to move in" have no intersection to offer.
 *
 * `all` is last in the control and is not the default. A hostel's roster
 * accumulates former residents forever, so opening on it means opening on a list
 * whose top rows are people who left — the default is the one an admin came for.
 */
export function rosterSegmentRows(
  residents: readonly AdminResident[],
  segment: RosterSegment,
): AdminResident[] {
  if (segment === "active") {
    return residents.filter((resident) => resident.status === "ACTIVE");
  }

  if (segment === "pending") {
    return residents.filter((resident) => resident.status === "PENDING");
  }

  return [...residents];
}

/**
 * Free-text search over the roster, client-side.
 *
 * ## Why not the server's `q`
 *
 * `residentListQuerySchema` takes one, so a server search exists — but the page
 * this screen already holds is 50 rows, which is most hostels in full, and a
 * request per keystroke over a hostel's connection feels worse than filtering
 * what is already in hand. A hostel large enough to page is a hostel whose admin
 * is at a desk, which is what the portal link on More is for.
 *
 * Matches across name, phone and room type **as one joined string**, so typing a
 * first name and a room type together still finds the row. Case-insensitive, and
 * an empty or whitespace-only query returns everything rather than nothing —
 * the field starts empty and must not start by hiding the list.
 */
export function searchResidents(
  residents: readonly AdminResident[],
  query: string,
): AdminResident[] {
  const needle = query.trim().toLowerCase();

  if (!needle) {
    return [...residents];
  }

  return residents.filter((resident) =>
    [resident.firstName, resident.lastName, resident.phone, resident.roomType, resident.roomNumber]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(needle),
  );
}

export function rosterSummary(residents: readonly AdminResident[]): RosterSummary {
  let active = 0;
  let pending = 0;

  for (const resident of residents) {
    if (resident.status === "ACTIVE") {
      active += 1;
    } else if (resident.status === "PENDING") {
      pending += 1;
    }
  }

  return { active, pending, total: residents.length };
}
