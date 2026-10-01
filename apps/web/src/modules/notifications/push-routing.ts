/**
 * Where a push notification takes you when it is tapped.
 *
 * Decided on the server so that adding a category ships its own destination,
 * and an older app build still lands somewhere sensible instead of on whatever
 * screen it happens to be showing. The mobile app treats `data.path` as opaque
 * and hands it to `router.push()`; paths therefore have to match the route
 * groups in `apps/mobile/src/app`.
 *
 * `actionUrl` wins when a notification carries one — that is already a
 * hand-picked destination for exactly this row, and it is what the web bell
 * links to, so the two surfaces agree.
 */

export type DeepLinkInput = {
  actionUrl?: string;
  category: string;
  data?: Record<string, unknown>;
};

/** Fallback per category. Anything unmapped goes to the notification list. */
const CATEGORY_PATHS: Record<string, string> = {
  ACCOUNT: "/(resident)/more/profile",
  ACCOUNT_DELETION: "/(resident)/more/settings",
  ANNOUNCEMENT: "/(resident)/notices",
  ATTENDANCE: "/(resident)/more/attendance",
  COMMUNITY: "/community",
  COMPLAINT: "/(resident)/more/complaints",
  ELECTRICIAN: "/(provider)",
  FOOD: "/(resident)/food",
  GENERAL: "/notifications",
  GUARDIAN: "/guardians",
  HOSTEL_APPROVAL: "/notifications",
  INQUIRY: "/(admin)",
  MAINTENANCE: "/(provider)",
  /*
   * The nightly prompt. Its buttons answer it without opening anything, so this
   * path is only reached by a plain tap on the notification body — or by a
   * build too old to have registered the category, where it is the whole
   * fallback.
   */
  NIGHT_STATUS: "/night-status",
  NOTICE: "/(resident)/notices",
  PAYMENT: "/(resident)/payments",
  PLUMBER: "/(provider)",
  RESIDENT: "/(admin)/residents",
  REVIEW: "/(resident)/more/reviews",
  ROOM: "/(resident)/more/profile",
  SERVICE_PROVIDER: "/(provider)",
  SOS: "/(admin)/alerts",
  URGENT: "/notifications",
};

const FALLBACK_PATH = "/notifications";

/**
 * `data.type` on a `PAYMENT` row about the hostel's own plan bill, as opposed
 * to a resident's rent. Written by `plan-due-reminders.service.ts`; read here
 * and in `web-routing.ts`.
 */
export const PLAN_DUE_NOTIFICATION_TYPE = "PLAN_DUE";

/**
 * A resident asked (or re-asked) to join through the hostel's join link. The
 * website's bell opens its Residents page, which holds the requests panel; the
 * app has a screen of its own for them, `app/manage/join-requests.tsx`.
 */
export const JOIN_REQUEST_NOTIFICATION_TYPE = "JOIN_REQUEST";

/** The admin app's plan Billing screen, `app/manage/billing.tsx`. */
const PLAN_BILLING_PATH = "/manage/billing";

export function isPlanDueNotification(input: {
  category: string;
  data?: Record<string, unknown>;
}) {
  return input.category === "PAYMENT" && input.data?.type === PLAN_DUE_NOTIFICATION_TYPE;
}

function readId(data: Record<string, unknown> | undefined, key: string) {
  const value = data?.[key];

  return typeof value === "string" && value.length > 0 ? value : null;
}

export function deepLinkForNotification(input: DeepLinkInput): string {
  /*
   * Ahead of `actionUrl`, because that row's `actionUrl` is the website's
   * `/{slug}/admin/billing` — what the web bell links to, and not a route in
   * the app. The PAYMENT default below is the resident's rent list, a stack an
   * admin account cannot open.
   */
  if (isPlanDueNotification(input)) {
    return PLAN_BILLING_PATH;
  }

  // Ahead of `actionUrl` (`/hostel-admin/residents`) for the same reason.
  if (input.data?.type === JOIN_REQUEST_NOTIFICATION_TYPE) {
    return "/manage/join-requests";
  }

  /*
   * Also ahead of `actionUrl`: a booking row's `actionUrl` is the website's
   * `/bookings/<id>` or `/hostel-admin/bookings`, neither of them an app route.
   * `data.audience` is written by `booking-notify.ts` on every booking bell. The
   * platform's own copies have no app screen — superadmins work on the web.
   */
  if (input.category === "BOOKING") {
    const bookingId = readId(input.data, "bookingId");

    if (input.data?.audience === "HOSTEL") {
      return "/manage/bookings";
    }

    return input.data?.audience === "GUEST" && bookingId ? `/booking/${bookingId}` : FALLBACK_PATH;
  }

  // A single leading slash only. `//evil.example` is protocol-relative — it
  // reads as a local path but resolves to another origin, so it must not reach
  // a router or a WebView.
  if (
    input.category !== "STORE_ORDER" &&
    input.actionUrl &&
    input.actionUrl.startsWith("/") &&
    !input.actionUrl.startsWith("//")
  ) {
    return input.actionUrl;
  }

  // A notification about one specific thing should open that thing, not its
  // list. The id is only trusted when the category says what it refers to —
  // `data` is written by many call sites and is not a stable schema.
  switch (input.category) {
    case "PAYMENT": {
      const invoiceId = readId(input.data, "invoiceId");
      return invoiceId ? `/(resident)/payments/${invoiceId}` : CATEGORY_PATHS.PAYMENT;
    }
    case "COMPLAINT": {
      const complaintId = readId(input.data, "complaintId");
      return complaintId
        ? `/(resident)/more/complaints/${complaintId}`
        : CATEGORY_PATHS.COMPLAINT;
    }
    case "NOTICE":
    case "ANNOUNCEMENT": {
      const noticeId = readId(input.data, "noticeId");
      return noticeId ? `/(resident)/notices/${noticeId}` : CATEGORY_PATHS.NOTICE;
    }
    case "FOOD": {
      /*
       * One category, two audiences. A "food is ready" row goes to a resident
       * and belongs on their Food tab; the copy of it written for the hostel's
       * own staff (`food-ready-notify.ts`) belongs on the admin Today screen —
       * `(resident)` is a route group a warden's account cannot open, so the
       * category default would land them nowhere useful.
       */
      if (input.data?.audience === "STAFF") {
        return "/(admin)/today";
      }

      /*
       * And a third: the kitchen's own copy — a menu change, or a resident
       * rating the food — belongs in the cook stack. `(resident)/food` is what
       * residents are shown and a cook account cannot open it.
       */
      if (input.data?.audience === "COOK") {
        return "/(cook)";
      }

      return CATEGORY_PATHS.FOOD;
    }
    case "COMMUNITY": {
      const postId = readId(input.data, "postId");
      return postId ? `/community/${postId}` : CATEGORY_PATHS.COMMUNITY;
    }
    case "GUARDIAN": {
      /*
       * Same two-audience shape as FOOD above. The resident's copy ("your
       * guardian accepted") belongs on the list they invited from; the
       * guardian's copy ("your access changed") belongs in the guardian stack,
       * which a resident account cannot open and vice versa.
       */
      return input.data?.audience === "GUARDIAN" ? "/(guardian)" : "/guardians";
    }
    case "STORE_ORDER": {
      const orderId = readId(input.data, "orderId");
      return orderId ? `/store/order/${orderId}` : "/(store)/orders";
    }
    default:
      return CATEGORY_PATHS[input.category] ?? FALLBACK_PATH;
  }
}
