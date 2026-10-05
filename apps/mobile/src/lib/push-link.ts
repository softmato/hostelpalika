/**
 * Turns a push notification's `data.path` into a route this build actually has.
 *
 * ## Why this exists
 *
 * The server decides the destination (`push-routing.ts` →
 * `deepLinkForNotification`), which is right: a new notification category ships
 * its own target, and one deploy fixes every installed app. But it decides it
 * against the route table someone *expected* mobile to have, and most of those
 * screens are M5/M7 work that does not exist yet. Checked against
 * `apps/mobile/src/app` today, the server emits eleven distinct paths and **one
 * still has no route**: `/(resident)/more/attendance`, which is M7 work. That one
 * entry is what the generic `/(resident)/more/` rewrite now exists for.
 *
 * Five more exist but not where the server points: invoices at `/invoice/<id>`
 * rather than `/(resident)/payments/<id>`, and complaints, profile, reviews and
 * settings under the root rather than `/(resident)/more/`. A folder nested under a
 * `<Tabs>` layout would become another tab, which is why M3 and M5 put them on the
 * root stack. `/community` and `/community/<id>` are the paths the server already
 * had right, and pass through untouched.
 *
 * Handing any of those straight to `router.push()` lands on `+not-found`. That
 * is the worst possible outcome for a push: the buzz was real, the notification
 * was real, and tapping it produces a broken-looking screen — so the next one
 * does not get tapped.
 *
 * ## Why the fix lives here and not only on the server
 *
 * Only the app knows which routes *this build* has, and the two ship on
 * different clocks: a phone that has not updated in a month still receives
 * today's paths. So the server keeps deciding intent and this decides
 * reachability. When M5 lands the complaints and profile screens, the entries
 * below turn into pass-throughs and nothing on the server changes.
 *
 * A path is also **untrusted input** — it arrives over the network inside a push
 * payload. The server refuses `//evil.example` before sending; this refuses it
 * again on arrival, because a client that trusts a field because the server
 * promised to sanitise it is one server bug away from routing wherever an
 * attacker likes.
 */

/** Where anything unroutable goes. It always exists and always says something. */
export const PUSH_FALLBACK_PATH = "/notifications";

/**
 * Routes a push may open, exactly as written. Anything not here is redirected
 * or dropped — an allow-list rather than a deny-list, because the failure mode
 * of a missed entry (lands on the notification list) is survivable and the
 * failure mode of a missed exclusion (lands on `+not-found`) is not.
 */
const KNOWN_PATHS = new Set([
  "/(admin)",
  "/community",
  "/(admin)/alerts",
  /*
   * Added with the five-tab retab: a push about a payment claim should land on
   * the tab that can approve it, not on a dashboard. `/(admin)/alerts` stays —
   * it is still a route, just no longer a tab — because pushes already in
   * flight from an older server build point at it.
   */
  "/(admin)/money",
  "/(admin)/residents",
  "/(admin)/today",
  "/(browse)",
  "/(cook)",
  "/(guardian)",
  "/(guardian)/payments",
  "/(guardian)/safety",
  "/(provider)",
  "/(provider)/card",
  "/(resident)",
  "/(resident)/food",
  "/(resident)/more",
  "/(resident)/notices",
  "/(resident)/payments",
  /* The person's own bookings, on the root stack. */
  "/bookings",
  /*
   * The resident's own guardian list, on the root stack. Added with the
   * guardian notifications — a resident told "your guardian accepted" has
   * exactly one screen that shows what that guardian can now see.
   */
  "/guardians",
  /*
   * The hostel's plan Billing screen, on the root stack. Where a plan payment
   * reminder lands — the server sends it for those rows ahead of their
   * `actionUrl`, which is the website's billing page.
   */
  "/manage/billing",
  /* A hostel's booking requests. Where a booking bell sent to the hostel lands (`push-routing.ts`, audience HOSTEL). */
  "/manage/bookings",
  /* Join-link requests waiting on staff (`push-routing.ts`, `JOIN_REQUEST`). */
  "/manage/join-requests",
  /*
   * The night-status screen, on the root stack. Reached by a plain tap on the
   * nightly prompt — the notification's own buttons answer it without opening
   * anything, so this is the path for somebody who wants to see the reason list
   * or change an answer they already gave.
   */
  "/night-status",
  "/notifications",
  /* The resident's Offer Program — certified receipts and offers. */
  "/offer-program/mine",
  /*
   * Where a refused provider application lands. `notifyServiceProviderDecision`
   * sends it as the `actionUrl` because that screen is the only one that offers
   * a corrected application, and it is the same path the website's bell links
   * to — so the two surfaces agree without a rewrite.
   */
  "/service-providers",
]);

/**
 * Rewrites for paths whose screen exists somewhere else, or not yet.
 *
 * Each entry is a prefix test rather than an exact match so a detail route
 * (`/(resident)/more/complaints/abc123`) collapses the same way its list does.
 * Order matters: the first match wins, so longer prefixes come first.
 */
const REWRITES: { prefix: string; to: string }[] = [
  /*
   * The web portal's residents page. A "new resident registered" notification
   * carries it as its `actionUrl` because that is what the web bell links to,
   * and `deepLinkForNotification` prefers an `actionUrl` over the category's
   * own path — so without this the app would send an admin who tapped it to the
   * notification list instead of the roster they were told about.
   */
  { prefix: "/hostel-admin/residents", to: "/(admin)/residents" },
  /*
   * The web portal's maintenance queue. Carried as the `actionUrl` on every
   * maintenance notification for the same reason the residents page is: it is
   * what the website's bell links to, and `deepLinkForNotification` prefers an
   * `actionUrl` over the category default. `manage/maintenance.tsx` is the
   * app's own version of that screen.
   */
  { prefix: "/hostel-admin/maintenance", to: "/manage/maintenance" },
  /*
   * Where a review notification lands. The website puts reviews under reports;
   * the app has `manage/reports.tsx`, which is the same screen.
   */
  { prefix: "/hostel-admin/reports", to: "/manage/reports" },
  /*
   * The rest of the portal pages the server names in an `actionUrl`, each to
   * the app's own screen for it — so a row in the bell opens what the website's
   * bell would, instead of only expanding.
   */
  { prefix: "/hostel-admin/inquiries", to: "/manage/inquiries" },
  { prefix: "/hostel-admin/complaints", to: "/manage/complaints" },
  { prefix: "/hostel-admin/food", to: "/manage/food" },
  // "Stock on the way" / "Stock received" — the website's stock page, the app's own.
  { prefix: "/hostel-admin/stock", to: "/stock" },
  { prefix: "/hostel-admin/bookings", to: "/manage/bookings" },
  { prefix: "/hostel-admin/payments", to: "/(admin)/money" },
  { prefix: "/hostel-admin/sos-alerts", to: "/(admin)/alerts" },
  { prefix: "/resident/payments", to: "/(resident)/payments" },
  { prefix: "/resident/notices", to: "/(resident)/notices" },
  /*
   * The resident's own guardian list, carried by "your guardian accepted".
   */
  { prefix: "/resident/guardians", to: "/guardians" },
  /* "Payment verified" and "you got an offer" both point here. */
  { prefix: "/resident/offer-program", to: "/offer-program/mine" },
  /*
   * A guardian being told their access changed. The website sends them to the
   * guardian dashboard; the app's guardian stack opens on the same thing.
   */
  { prefix: "/guardian/dashboard", to: "/(guardian)" },
  /*
   * The website's provider job feed. An approval notification carries `/jobs` as
   * its `actionUrl` because that is the provider's only screen on the web, and
   * `deepLinkForNotification` prefers an `actionUrl` over the category's own
   * path — so without this the one notification that *converts the app into the
   * provider app* would land on the notification list.
   */
  { prefix: "/jobs", to: "/(provider)" },
  /*
   * Built in M5.4, and on the root stack for the usual reason. First in the list
   * because the generic `/(resident)/more/` rule below would otherwise swallow it
   * — the order in this array is the precedence.
   */
  { prefix: "/(resident)/more/profile", to: "/profile" },
  /* M5.7, same reasoning. */
  { prefix: "/(resident)/more/reviews", to: "/review" },
  /* M5.9. */
  { prefix: "/(resident)/more/settings", to: "/settings" },
  /*
   * The M5 screens still unbuilt. They land on the More tab, which is where those
   * entries are listed with the release they arrive in — a real destination that
   * explains itself, rather than the notification list the user just came from.
   *
   * Ordered after `COMPLAINT_DETAIL` below, which is checked first: complaints
   * are built now, so they must not be swallowed by this prefix.
   */
  { prefix: "/(resident)/more/", to: "/(resident)/more" },
  /*
   * Notices have no detail route: the list expands rows in place, and expanding
   * is what marks them read. Sending a notice push to the list is therefore
   * exactly right, not a degradation.
   */
  { prefix: "/(resident)/notices/", to: "/(resident)/notices" },
];

/** `/(resident)/payments/<invoiceId>` — the one path that is wrong, not absent. */
const PAYMENT_DETAIL = /^\/\(resident\)\/payments\/([A-Za-z0-9_-]+)$/;

/**
 * `/(resident)/more/complaints[/<id>]` → `/complaints[/<id>]`.
 *
 * Built in M5.2, and on the root stack for the reason invoices are: a folder
 * under a `<Tabs>` layout becomes another tab. The list form has to be matched
 * here too, or the `/(resident)/more/` rewrite below would send it to the More
 * tab — a working screen replaced by a menu that links to it.
 */
const COMPLAINT_PATH = /^\/\(resident\)\/more\/complaints(?:\/([A-Za-z0-9_-]+))?$/;

/**
 * `/community/<postId>` — built in M5.8, and the one server path that was already
 * correct: the app puts community at the same place the web does, so this passes
 * through rather than being rewritten. Matched explicitly anyway, because the id
 * has to be checked before it reaches `router.push`.
 */
const COMMUNITY_POST = /^\/community\/([A-Za-z0-9_-]+)$/;

/**
 * `/booking/<id>` — a booking bell sent to the person who booked (`push-routing.ts`, audience GUEST).
 * The website's own `/bookings/<id>`, carried as that bell's `actionUrl`, is the same booking.
 */
const BOOKING_DETAIL = /^\/bookings?\/([A-Za-z0-9_-]+)$/;

/** `/store/order/<id>` — a store order the hostel placed; the same path on both surfaces. */
const STORE_ORDER = /^\/store\/order\/([A-Za-z0-9_-]+)$/;

/** `/join/<token>` — "your request was sent back", landing on the join form to fix it. */
const JOIN_LINK = /^\/join\/([A-Za-z0-9_-]+)$/;

/**
 * Resolves a server-supplied path to something routable.
 *
 * Returns `PUSH_FALLBACK_PATH` rather than `null` for anything it cannot place:
 * a tapped notification must always go *somewhere*, and the list it came from
 * is the honest answer.
 */
export function resolvePushPath(path: unknown): string {
  if (typeof path !== "string") {
    return PUSH_FALLBACK_PATH;
  }

  const trimmed = path.trim();

  // One leading slash, and only one. `//evil.example` reads as a path and
  // resolves as an origin; `hostelpalika://` and `https://` are not ours to route.
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) {
    return PUSH_FALLBACK_PATH;
  }

  // Query strings and fragments are not part of any route we match on, and a
  // `?` would defeat every comparison below.
  const clean = trimmed.split(/[?#]/)[0];

  // Trailing slash is meaningless to expo-router but would miss every lookup.
  const normalized = clean.length > 1 && clean.endsWith("/") ? clean.slice(0, -1) : clean;

  const invoice = PAYMENT_DETAIL.exec(normalized);

  if (invoice) {
    return `/invoice/${invoice[1]}`;
  }

  const complaint = COMPLAINT_PATH.exec(normalized);

  if (complaint) {
    return complaint[1] ? `/complaints/${complaint[1]}` : "/complaints";
  }

  const communityPost = COMMUNITY_POST.exec(normalized);

  if (communityPost) {
    return `/community/${communityPost[1]}`;
  }

  const booking = BOOKING_DETAIL.exec(normalized);

  if (booking) {
    return `/booking/${booking[1]}`;
  }

  const order = STORE_ORDER.exec(normalized);

  if (order) {
    return `/store/order/${order[1]}`;
  }

  const join = JOIN_LINK.exec(normalized);

  if (join) {
    return `/join/${join[1]}`;
  }

  if (KNOWN_PATHS.has(normalized)) {
    return normalized;
  }

  for (const rule of REWRITES) {
    if (normalized.startsWith(rule.prefix)) {
      return rule.to;
    }
  }

  return PUSH_FALLBACK_PATH;
}

/**
 * The push that means "your account is a resident account now".
 *
 * Sent by `notifyResidentRegistered` on the server when a hostel registers
 * somebody whose platform account it managed to link, and by
 * `notifyServiceProviderDecision` when platform staff approve a provider. These
 * are the only notifications in the product that are about the *recipient's own
 * role* rather than about a thing they can go and look at.
 *
 * ## Why the app cannot just route it and be done
 *
 * The promotion happened in the database. Every request this phone makes is
 * authorised from the claims inside its access token, which still say `PUBLIC` —
 * so tapping through to a resident screen would land on tabs whose every call
 * comes back 403, and 403s are not 401s, so nothing in the HTTP layer would
 * refresh either. The token has to be rotated first (`revalidateSession`), and
 * that is what `usePush` does when this predicate is true.
 *
 * ## Kept as a literal string on both sides
 *
 * The server writes the same words in `resident-registered-notify.ts` and
 * `service-provider-notify.ts`. It is
 * deliberately not a shared package constant: the API and an installed app ship
 * on different clocks, a phone can be a month behind, and a value both sides
 * must agree on forever is clearer frozen in two places with a comment than
 * imported from one that looks safe to rename.
 */
const ROLE_CHANGE_TYPES = new Set([
  "RESIDENT_REGISTERED",
  /*
   * A provider application approved by platform staff.
   *
   * Same shape as the registration above and the same failure without it: the
   * decision happens in the database, this phone's access token and cached
   * account still say "an ordinary public account", and `resolveHome` routes on
   * exactly that flag — so the app stays the hostel-shopping shell until it is
   * killed and cold-started. A tradesperson who has just been told by email that
   * they are verified opens the app and finds nothing has changed.
   *
   * Written by `notifyServiceProviderDecision` on the server, where the same
   * literal is frozen with the same reasoning.
   */
  "SERVICE_PROVIDER_APPROVED",
]);

/**
 * Is this a reminder about the hostel's own plan bill?
 *
 * Its push already lands on Billing through `data.path`; this is for the row in
 * the bell, which has no path — only the website's `actionUrl`, which is not a
 * route here. The literal is frozen on both sides for the reason given above:
 * the server writes it in `plan-due-reminders.service.ts`.
 */
export function opensPlanBilling(notification: { category?: unknown; data?: unknown }): boolean {
  const data = notification.data;

  return (
    notification.category === "PAYMENT" &&
    Boolean(data) &&
    typeof data === "object" &&
    (data as { type?: unknown }).type === "PLAN_DUE"
  );
}

/**
 * Where tapping a row in the notification list goes, or `null` to expand it.
 *
 * The same answer its push gives (`deepLinkForNotification` on the server, then
 * `resolvePushPath`), read from the row: the two typed rows first, because their
 * `actionUrl` is the website's page; then the `actionUrl` itself. A row nothing
 * here can place expands in place — the list it is in is not a destination.
 */
export function notificationRoute(notification: {
  actionUrl?: unknown;
  category?: unknown;
  data?: unknown;
}): string | null {
  if (opensPlanBilling(notification)) {
    return "/manage/billing";
  }

  const data = notification.data;

  if (data && typeof data === "object" && (data as { type?: unknown }).type === "JOIN_REQUEST") {
    return "/manage/join-requests";
  }

  const path = resolvePushPath(notification.actionUrl);

  return path === PUSH_FALLBACK_PATH ? null : path;
}

/**
 * Does this payload say the recipient's own role has changed?
 *
 * Reads `data.type` defensively — the payload is network input, `data` is
 * written by many call sites and is not a stable schema, and an older server
 * build sends no `type` at all.
 */
export function marksRoleChange(data: unknown): boolean {
  if (!data || typeof data !== "object") {
    return false;
  }

  const type = (data as { type?: unknown }).type;

  return typeof type === "string" && ROLE_CHANGE_TYPES.has(type);
}
