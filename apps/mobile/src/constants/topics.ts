/**
 * The domain topics the server publishes on `resource:changed`.
 *
 * Mirrors `REALTIME_TOPIC` in `apps/web/src/lib/realtime/channels.ts`. Kept as
 * its own tiny module rather than living in `lib/realtime.ts` because that file
 * `require`s `pusher-js/react-native`, which reaches React Native — and Vitest
 * here is node-side with no RN shim, so `lib/resource-bus.ts` could not be
 * tested if it imported its topic list from there.
 *
 * Mobile does not carry the web's `TOPIC_ENDPOINTS` table. That table exists to
 * turn a topic into query-cache keys; on mobile a screen names its own topics
 * and re-runs the loader it already holds, so there is nothing to map.
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

export const REALTIME_TOPIC_VALUES = Object.values(REALTIME_TOPIC) as RealtimeTopic[];
