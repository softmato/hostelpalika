import { REALTIME_TOPIC } from "@/constants/topics";
import {
  comparePublicHostels,
  type HostelFilters,
  listPublicHostels,
  type PublicHostel,
} from "@/lib/public-api";
import { getMyJoinRequest, type MyJoinRequest } from "@/lib/join-api";
import { defineQuery, prefetchQuery, type Query } from "@/lib/query-cache";
import { getSiteConfig, type MobileSiteConfig } from "@/lib/site-config-api";

/**
 * The reads a signed-out phone makes, named once.
 *
 * The sibling of `store-queries.ts` and `community-queries.ts`, and it exists
 * for the same reason the store's did: **the public catalogue was read by four
 * screens and keyed by none of them.** The home screen, the map, Saved and the
 * browser each called `listPublicHostels()` with no `cacheKey`, so the same
 * answer was fetched from scratch — behind a full-screen spinner — every time
 * one of them was opened, and thrown away again on unmount.
 *
 * They are one key now. Opening the map from the home screen paints the pins
 * from what the home screen already fetched and revalidates silently behind
 * them; Saved does the same, which matters most because `app/saved.tsx` reads
 * the whole catalogue only to intersect it with a local id list.
 *
 * ## Why the filters are in the key rather than kept out of it
 *
 * `hostel-browser.tsx` varies its filters, including a free-text `q`, and the
 * store's rule against keying a search box does not apply here: that box keys
 * on *submit* and on the navigation params, never on a keystroke — see the
 * `applied` ref in that file. A filtered browse is a different question with a
 * different answer, so it gets a different entry, and going back to an earlier
 * filter paints rather than asks.
 *
 * The unfiltered read is deliberately spelled `public:hostels` with no suffix.
 * It is the one the other three screens make, and a key that serialised `{}`
 * into it would be a different string in each of them.
 */

export type PublicQuery<T> = Query<T>;

/**
 * Serialised by sorted entry so that two objects with the same filters in a
 * different order are the same question. `undefined` values are dropped, which
 * is what `definedParams` does to the request itself.
 */
function filterKey(filters: HostelFilters) {
  const entries = Object.entries(filters)
    .filter(([, value]) => value !== undefined && value !== "")
    .sort(([a], [b]) => a.localeCompare(b));

  return entries.length === 0
    ? ""
    : `:${entries.map(([key, value]) => `${key}=${String(value)}`).join(",")}`;
}

export const publicQuery = {
  /**
   * Two or more hostels side by side.
   *
   * Sorted, because the comparison is the same one whichever order the reader
   * ticked them in, and the screen rebuilds this array on every render.
   */
  compare: (ids: readonly string[]): PublicQuery<Awaited<ReturnType<typeof comparePublicHostels>>> =>
    defineQuery(
      `public:compare:${[...ids].sort().join(",")}`,
      [REALTIME_TOPIC.HOSTELS],
      () => comparePublicHostels([...ids]),
    ),

  hostels: (filters: HostelFilters = {}): PublicQuery<PublicHostel[]> =>
    defineQuery(`public:hostels${filterKey(filters)}`, [REALTIME_TOPIC.HOSTELS], () =>
      listPublicHostels(filters),
    ),

  /**
   * The signed-in person's own join request, keyed by account so a sign-out
   * never paints the last person's. On the notifications topic: "sent back"
   * arrives as a notification, and the row should change with it.
   */
  myJoinRequest: (userId: string): PublicQuery<MyJoinRequest> =>
    defineQuery(`public:my-join-request:${userId}`, [REALTIME_TOPIC.NOTIFICATIONS], () =>
      getMyJoinRequest(),
    ),

  /**
   * The site's own copy and configuration. No topic: it is changed by a
   * platform admin on the web, never by anything the socket publishes, and a
   * refocus is soon enough to notice.
   */
  siteConfig: (): PublicQuery<MobileSiteConfig> =>
    defineQuery("public:site-config", [], () => getSiteConfig()),
} as const;

/** Warms one descriptor. Never throws, never re-asks something already fresh. */
export function prefetchPublicQuery<T>(query: PublicQuery<T>) {
  prefetchQuery(query.key, query.load, { topics: query.topics });
}
