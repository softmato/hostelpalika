import { router } from "expo-router";
import { useCallback } from "react";

import { IconButton } from "@/components/ui/icon-button";
import { useAppSelector } from "@/hooks/redux";
import { useResource } from "@/hooks/use-resource";
import {
  DEFAULT_NOTIFICATION_FILTER,
  notificationQuery,
} from "@/lib/notification-queries";
import type { NotificationFeed } from "@/lib/notifications-api";

/**
 * The bell, and the unread count on it.
 *
 * ## Why a role's app bar has one at all
 *
 * `/notifications` is scoped to `principal.userId` with no role branch, so every
 * signed-in account already has a feed — an admin's includes the claim
 * notifications `notifyAdminsOfClaim` writes and the SOS fan-out to wardens.
 * The public home had the only bell in the app, which meant a hostel admin's
 * notifications were reachable only by leaving their own tabs. Same control,
 * same destination, now on the screens where the alerts are about.
 *
 * ## It is not the action queue
 *
 * The bell is the chronological record of what the platform sent you. The
 * decisions — verify this claim, reply to this complaint — live on the tab that
 * owns them, with the money and the evidence next to them. Two surfaces, and on
 * purpose: a notification you have read is done with, whereas a claim stays in
 * the queue until somebody decides.
 *
 * ## The badge and the screen are one request
 *
 * This used to fetch `filter=unread` for the count while `app/notifications.tsx`
 * fetched `filter=all` for the list, neither of them keyed — two requests for
 * one answer, on every tab carrying a bell. Both now read
 * `notificationQuery.feed("all")`, whose `unreadCount` is counted over the whole
 * mailbox rather than over the page it returns. `lib/notification-queries.ts`
 * has the rest of it, including why `role-tabs.tsx` warms that key on the way
 * into every portal — which is what makes this badge paint rather than count.
 */

/** What a signed-out shell shows: no badge, and no request behind it. */
const EMPTY_FEED: NotificationFeed = {
  actionCount: 0,
  notifications: [],
  unreadCount: 0,
};
export function NotificationBell({
  /** Passed through to `IconButton` — `onAccent` on a painted app bar or hero. */
  tone = "default",
}: {
  tone?: "default" | "onAccent";
} = {}) {
  const account = useAppSelector((state) => state.auth.account);

  const query = notificationQuery.feed(DEFAULT_NOTIFICATION_FILTER);

  /*
   * No account, no request — `useResource` fetches on mount and on every
   * refocus, so a signed-out shell would otherwise send a 401 per visit.
   *
   * The key follows the same rule. Keyed for a signed-out shell, the empty feed
   * above would be *written* to the entry the notifications screen paints from,
   * and the first thing a reader saw after signing in would be an empty mailbox
   * being quietly revalidated. Without a key `useResource` holds it in component
   * state, which is where a placeholder belongs.
   *
   * `notifications` as a topic makes the count live: the socket publishes it on
   * `notification:new`, so the badge moves while the app is open without a poll.
   */
  const feed = useResource<NotificationFeed>(
    useCallback(async () => (account ? await query.load() : EMPTY_FEED), [account, query]),
    { cacheKey: account ? query.key : undefined, topics: query.topics },
  );

  // A failed count is not worth reporting from an app bar: the bell shows no
  // badge, which is what it shows when there is nothing unread anyway.
  const unread = feed.data?.unreadCount ?? 0;

  return (
    <IconButton
      badge={unread}
      label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
      name="notifications"
      onPress={() => router.push("/notifications")}
      tone={tone}
    />
  );
}
