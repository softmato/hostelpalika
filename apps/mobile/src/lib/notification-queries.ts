/**
 * The bell's read, named once — the one question every portal asks.
 *
 * The sibling of `admin-queries.ts`, `resident-queries.ts`, `cook-queries.ts`
 * and `guardian-queries.ts`, and the only one of the five that belongs to no
 * portal at all. `GET /notifications` runs `requireApiPrincipal` and filters on
 * `userId` with no role branch, so a resident, a warden, a cook, a guardian, a
 * service provider and a signed-in browsing account all ask it — which is
 * exactly why it could not live in any one portal's registry, the same argument
 * `role-tabs.tsx` already makes for the community board.
 *
 * ## One key for the bell and the screen
 *
 * This was two requests for one answer. `<NotificationBell>` fetched
 * `filter=unread` for its badge and `app/notifications.tsx` fetched `filter=all`
 * for its list, both with no `cacheKey`, so every screen carrying a bell asked
 * on mount and the screen the bell opened asked again — on the tab bars where a
 * bell sits on four of five tabs, that is four requests to draw one number.
 *
 * They are now the same key. `listNotifications` counts `unreadCount` and
 * `actionCount` over the whole mailbox rather than over the page it returns —
 * `notification.service.ts` says so in as many words — so the `all` payload
 * carries everything the badge needs. The badge paints from cache, the screen
 * paints from the same entry, and marking a row read moves both at once because
 * `use-resource`'s optimistic `setData` writes back to the key they share.
 *
 * ## Why the feed is worth warming and most reads are not
 *
 * The bell is drawn on nearly every tab of every portal, so the answer is needed
 * whether or not anybody opens it — the badge is the read. That makes it the
 * cheapest possible warm-up to justify: it is not speculation about where
 * somebody will go next, it is the number already on screen.
 */

import { REALTIME_TOPIC } from "@/constants/topics";
import {
  type NotificationFeed,
  type NotificationFilter,
  listNotifications,
} from "@/lib/notifications-api";
import { defineQuery, prefetchQuery, type Query, readSavedQuery } from "@/lib/query-cache";

/** The server's page; a newer-rows answer this long may have a gap behind it. */
const PAGE = 100;
/** Past this the cached rows' read ticks may have drifted (read on the website); ask for all. */
const FULL_AFTER_MS = 6 * 60 * 60_000;

/**
 * F1: newer rows on top of the cached ones. The counts are the server's; when it
 * says nothing is unread, every cached row is read too, which heals a feed read
 * on another device without asking for it again.
 */
export function mergeFeed(cached: NotificationFeed, newer: NotificationFeed): NotificationFeed {
  if (newer.notifications.length >= PAGE) return newer;
  const fresh = new Set(newer.notifications.map((row) => row.id));
  const kept = cached.notifications
    .filter((row) => !fresh.has(row.id))
    .map((row) => (newer.unreadCount === 0 && !row.isRead ? { ...row, isRead: true } : row));
  return { ...newer, notifications: [...newer.notifications, ...kept].slice(0, PAGE) };
}

async function loadFeed(filter: NotificationFilter, key: string) {
  // "Needs action" rows leave that list when acted on, so it is always asked whole.
  const saved = filter === "all" ? readSavedQuery<NotificationFeed>(key) : null;
  const newest = saved?.data.notifications[0]?.createdAt;
  if (!saved || !newest || Date.now() - saved.storedAt > FULL_AFTER_MS) {
    return listNotifications(filter);
  }
  return mergeFeed(saved.data, await listNotifications(filter, newest));
}

export type NotificationQuery<T> = Query<T>;

/**
 * The filter the bell reads and the screen opens on.
 *
 * Not a default parameter on `feed` — a caller that forgot to pass one would
 * silently share this entry, and the two other filters return genuinely
 * different lists.
 */
export const DEFAULT_NOTIFICATION_FILTER: NotificationFilter = "all";

export const notificationQuery = {
  /**
   * One filter's page of the mailbox.
   *
   * The filter is in the key because it changes the answer — `unread` and
   * `action` return different rows, and the screen's chips switch between them.
   * The two counts do not vary by filter, which is what lets the badge read
   * whichever entry it likes.
   */
  feed: (filter: NotificationFilter): NotificationQuery<NotificationFeed> =>
    defineQuery(`notifications:${filter}`, [REALTIME_TOPIC.NOTIFICATIONS], () =>
      loadFeed(filter, `notifications:${filter}`),
    ),
} as const;

/** Warms one descriptor. Never throws, never re-asks something already fresh. */
export function prefetchNotificationQuery<T>(query: NotificationQuery<T>) {
  prefetchQuery(query.key, query.load, { topics: query.topics });
}

/**
 * The feed, warmed for whichever shell is being entered.
 *
 * Called from `role-tabs.tsx`, which is the one component every portal's layout
 * mounts, and only for a signed-in account — the endpoint is 401 for anybody
 * else, and `(browse)` runs signed out.
 *
 * Only `all` is warmed. The other two filters are one tap away *and* behind a
 * screen this has already made instant, so warming them would be three requests
 * to save the second one somebody might not make.
 */
export function prefetchNotifications() {
  prefetchNotificationQuery(notificationQuery.feed(DEFAULT_NOTIFICATION_FILTER));
}
