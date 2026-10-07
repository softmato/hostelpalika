/**
 * Channel, event and topic vocabulary for the real-time layer.
 *
 * Imported by both the server publisher and the browser subscriber, so it must
 * stay free of anything Node- or DOM-specific.
 *
 * Four channel scopes, matching the ways a portal is addressed:
 *
 *  - `private-user-<userId>`   one person's notification feed (the bell);
 *  - `private-hostel-<id>`     everyone working inside one hostel;
 *  - `private-platform`        platform staff (superadmin / moderator);
 *  - `private-global`          every signed-in account, any role or portal.
 *
 * All four are Pusher *private* channels, so subscribing requires a signed
 * grant from `/api/v1/realtime/auth` — a resident cannot listen to a hostel
 * channel by guessing its id. `private-global` is private too, even though
 * everyone authenticated may join it: that keeps platform broadcasts off a
 * public channel that anyone holding the app key could tune into.
 */

export const REALTIME_EVENT = {
  /** A notification row was created for the recipient. Payload: the row. */
  NOTIFICATION_NEW: "notification:new",
  /** A notification was read or actioned elsewhere. Payload: `{ id }`. */
  NOTIFICATION_UPDATED: "notification:updated",
  /** Server-side data changed. Payload: `{ topics: RealtimeTopic[] }`. */
  RESOURCE_CHANGED: "resource:changed",
  /**
   * A platform-wide announcement, broadcast on `private-global` to everyone
   * signed in at once.
   *
   * This is the one event that is *not* backed by a per-recipient row at send
   * time. A campaign to fifty thousand accounts cannot fan out fifty thousand
   * socket messages, so the broadcast goes out once here for the instant
   * banner, and the durable `Notification` rows are written by the dispatch
   * cron for anyone offline. A client that receives both de-duplicates on the
   * campaign id.
   */
  GLOBAL_ANNOUNCEMENT: "global:announcement",
} as const;

export type RealtimeEvent = (typeof REALTIME_EVENT)[keyof typeof REALTIME_EVENT];

/**
 * Domain areas a panel can be watching.
 *
 * Services publish *topics*, not URLs, so a notify call never has to know which
 * portal renders it. `TOPIC_ENDPOINTS` below is the single place that turns a
 * topic into the endpoints whose caches must drop — every portal reading one of
 * those prefixes refreshes, which is what makes "all tabs stay live" true
 * without each panel wiring up its own subscription.
 */
export const REALTIME_TOPIC = {
  ATTENDANCE: "attendance",
  BOOKINGS: "bookings",
  COMMUNITY: "community",
  COMPLAINTS: "complaints",
  FOOD: "food",
  HOSTELS: "hostels",
  INQUIRIES: "inquiries",
  MAINTENANCE: "maintenance",
  NOTICES: "notices",
  NOTIFICATIONS: "notifications",
  PAYMENTS: "payments",
  RESIDENTS: "residents",
  REVIEWS: "reviews",
  ROOMS: "rooms",
  SAFETY: "safety",
  SERVICE_PROVIDERS: "service-providers",
  STORE: "store",
} as const;

export type RealtimeTopic = (typeof REALTIME_TOPIC)[keyof typeof REALTIME_TOPIC];

/**
 * Endpoint prefixes to invalidate per topic. A trailing `*` is the wildcard
 * `useInvalidateResources` already understands, so one entry covers a list
 * endpoint and every detail route beneath it.
 */
export const TOPIC_ENDPOINTS: Record<RealtimeTopic, string[]> = {
  [REALTIME_TOPIC.ATTENDANCE]: [
    "/api/v1/hostel-admin/attendance*",
    "/api/v1/resident/attendance*",
    "/api/v1/guardian/attendance*",
    "/api/v1/hostel-admin/dashboard*",
  ],
  /* The guest's booking, the hostel's requests and the platform's queues all move together. */
  [REALTIME_TOPIC.BOOKINGS]: [
    "/api/v1/bookings*",
    "/api/v1/hostel-admin/bookings*",
    "/api/v1/platform/bookings*",
  ],
  [REALTIME_TOPIC.COMMUNITY]: ["/api/v1/community*", "/api/v1/platform/community*"],
  [REALTIME_TOPIC.COMPLAINTS]: [
    "/api/v1/hostel-admin/complaints*",
    "/api/v1/resident/complaints*",
    "/api/v1/guardian/complaints*",
    "/api/v1/hostel-admin/dashboard*",
  ],
  [REALTIME_TOPIC.FOOD]: [
    "/api/v1/hostel-admin/food*",
    "/api/v1/resident/food*",
    "/api/v1/guardian/food*",
  ],
  [REALTIME_TOPIC.HOSTELS]: [
    "/api/v1/platform/hostels*",
    "/api/v1/platform/dashboard*",
    "/api/v1/hostel-admin/hostel*",
    "/api/v1/hostel-admin/dashboard*",
  ],
  [REALTIME_TOPIC.INQUIRIES]: [
    "/api/v1/hostel-admin/inquiries*",
    "/api/v1/platform/inquiries*",
    "/api/v1/hostel-admin/dashboard*",
  ],
  [REALTIME_TOPIC.MAINTENANCE]: [
    "/api/v1/hostel-admin/maintenance*",
    "/api/v1/resident/maintenance*",
    "/api/v1/service-provider/jobs*",
  ],
  [REALTIME_TOPIC.NOTICES]: [
    "/api/v1/hostel-admin/notices*",
    "/api/v1/resident/notices*",
    "/api/v1/guardian/notices*",
  ],
  [REALTIME_TOPIC.NOTIFICATIONS]: [
    "/api/v1/notifications*",
    "/api/v1/hostel-admin/notifications*",
    "/api/v1/platform/notifications*",
  ],
  [REALTIME_TOPIC.PAYMENTS]: [
    "/api/v1/hostel-admin/finance*",
    "/api/v1/resident/finance*",
    "/api/v1/cook/khata*",
    "/api/v1/guardian/payments*",
    "/api/v1/platform/billing*",
    "/api/v1/hostel-admin/dashboard*",
    "/api/v1/platform/dashboard*",
  ],
  [REALTIME_TOPIC.RESIDENTS]: [
    "/api/v1/hostel-admin/residents*",
    "/api/v1/hostel-admin/dashboard*",
  ],
  [REALTIME_TOPIC.REVIEWS]: ["/api/v1/platform/reviews*", "/api/v1/hostel-admin/reviews*"],
  // Rooms are `roomConfigurations` counts on the hostel document, not their own
  // collection — so occupancy shows up on the room-type picker and the hostel
  // profile rather than on any `/rooms` route.
  [REALTIME_TOPIC.ROOMS]: [
    "/api/v1/hostel-admin/room-types*",
    "/api/v1/hostel-admin/profile*",
    "/api/v1/hostel-admin/dashboard*",
  ],
  [REALTIME_TOPIC.SAFETY]: [
    "/api/v1/hostel-admin/sos*",
    "/api/v1/hostel-admin/night-status*",
    "/api/v1/guardian/safety*",
    "/api/v1/resident/sos*",
  ],
  [REALTIME_TOPIC.SERVICE_PROVIDERS]: [
    "/api/v1/platform/service-providers*",
    "/api/v1/hostel-admin/service-providers*",
    "/api/v1/service-provider*",
  ],
  /*
   * One topic for the whole supply store, buyer and seller side.
   *
   * Splitting it into catalogue/cart/orders was the first instinct and would
   * have been wrong: a placed order moves stock, which moves the shop list, the
   * cart that is quoting from it and both order queues at once. Three topics
   * would mean every publisher naming all three, which is one topic with extra
   * steps and three chances to forget one.
   *
   * The cart is deliberately absent from this list. It is per-hostel and only
   * ever changed by the person looking at it, so invalidating it on a
   * platform-wide catalogue edit would be a request per hostel for nothing.
   */
  [REALTIME_TOPIC.STORE]: [
    "/api/v1/store/products*",
    "/api/v1/store/orders*",
    "/api/v1/platform/store*",
  ],
};

/**
 * Which panels a notification's `category` implies have changed.
 *
 * Every notification is written because something moved in the database, so
 * rather than making each of the ~15 notify helpers remember to publish a
 * resource change as well, `createInAppNotification` derives the topic from the
 * category it was already given. Helpers still publish explicitly when the
 * change needs a *wider* audience than the recipient — a hostel-wide or
 * platform-wide refresh — but nothing is silently missed when a new category
 * appears: an unmapped one simply skips the panel refresh and still delivers.
 */
export const CATEGORY_TOPICS: Record<string, RealtimeTopic[]> = {
  ACCOUNT: [],
  ACCOUNT_DELETION: [],
  ANNOUNCEMENT: [REALTIME_TOPIC.NOTICES],
  ATTENDANCE: [REALTIME_TOPIC.ATTENDANCE],
  BOOKING: [REALTIME_TOPIC.BOOKINGS],
  COMMUNITY: [REALTIME_TOPIC.COMMUNITY],
  COMPLAINT: [REALTIME_TOPIC.COMPLAINTS],
  ELECTRICIAN: [REALTIME_TOPIC.MAINTENANCE],
  FOOD: [REALTIME_TOPIC.FOOD],
  GENERAL: [],
  HOSTEL_APPROVAL: [REALTIME_TOPIC.HOSTELS],
  INQUIRY: [REALTIME_TOPIC.INQUIRIES],
  KHATA: [REALTIME_TOPIC.PAYMENTS],
  MAINTENANCE: [REALTIME_TOPIC.MAINTENANCE],
  NOTICE: [REALTIME_TOPIC.NOTICES],
  PAYMENT: [REALTIME_TOPIC.PAYMENTS],
  PLUMBER: [REALTIME_TOPIC.MAINTENANCE],
  REVIEW: [REALTIME_TOPIC.REVIEWS],
  ROOM: [REALTIME_TOPIC.ROOMS],
  SERVICE_PROVIDER: [REALTIME_TOPIC.SERVICE_PROVIDERS],
  SOS: [REALTIME_TOPIC.SAFETY],
  STOCK: [REALTIME_TOPIC.FOOD],
  STORE_ORDER: [REALTIME_TOPIC.STORE],
  URGENT: [REALTIME_TOPIC.SAFETY],
};

export function topicsForCategory(category: string): RealtimeTopic[] {
  return CATEGORY_TOPICS[category] ?? [];
}

export function userChannel(userId: string) {
  return `private-user-${userId}`;
}

export function hostelChannel(hostelId: string) {
  return `private-hostel-${hostelId}`;
}

export const PLATFORM_CHANNEL = "private-platform";

/** Every signed-in account, regardless of role or portal. */
export const GLOBAL_CHANNEL = "private-global";

/**
 * The hostel registration track sheet — a Pusher *presence* channel, so every
 * viewer knows who else has the page open. Deliberately not offered by
 * `realtimeChannelsFor`: the portal shell subscribes to everything that returns,
 * and would show every signed-in superadmin as "on the sheet".
 */
export const TRACK_SHEET_CHANNEL = "presence-hostel-registration-track-sheet";

export const TRACK_SHEET_EVENT = {
  /** A viewer moved onto a line, or off every line. Payload: `{ at, line, userId }`. */
  FOCUS: "track-sheet:focus",
  /** Lines were saved. Payload: `{ userId }`. */
  SAVED: "track-sheet:saved",
} as const;

/** Endpoints to invalidate for a batch of topics, de-duplicated. */
export function endpointsForTopics(topics: readonly string[]) {
  const endpoints = new Set<string>();

  for (const topic of topics) {
    for (const endpoint of TOPIC_ENDPOINTS[topic as RealtimeTopic] ?? []) {
      endpoints.add(endpoint);
    }
  }

  return [...endpoints];
}
