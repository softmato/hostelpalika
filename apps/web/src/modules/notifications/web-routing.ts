import { Role } from "@/lib/roles";
import { isPlanDueNotification } from "@/modules/notifications/push-routing";

/**
 * Where a **browser** push notification takes you when it is clicked.
 *
 * The counterpart of `push-routing.ts`, and separate from it for one reason
 * that is not going away: the phone app resolves a destination through Expo
 * Router's role-scoped groups — `/(resident)/payments` means "the payments
 * screen of whichever role stack this build is showing" — while the website has
 * no such thing. `/resident/payments` and `/hostel-admin/payments` are two
 * different URLs, one of which turns the other's audience away at the portal
 * guard.
 *
 * So this takes the recipient's `role` and the notification's category and
 * answers with a URL that person can actually open. Getting it wrong is not
 * cosmetic: a click that lands on a guard reads as "you are not allowed here"
 * for a message the platform chose to send them, which is worse than landing on
 * a list.
 *
 * ## Why `actionUrl` still wins
 *
 * Most notifications already carry one, it is already a website path (the bell
 * links straight to it), and it is already the most specific destination anyone
 * has for that row. A category default can only ever be a list; `actionUrl` is
 * the thing itself.
 */

export type WebLinkInput = {
  actionUrl?: string;
  category: string;
  data?: Record<string, unknown>;
  role?: string | null;
};

/** Every portal's own notification list — the destination that always exists. */
const NOTIFICATION_LIST: Record<string, string> = {
  [Role.SUPERADMIN]: "/platform/inbox",
  [Role.PLATFORM_MODERATOR]: "/platform/inbox",
  [Role.HOSTEL_ADMIN]: "/hostel-admin/inbox",
  [Role.WARDEN]: "/hostel-admin/inbox",
  /*
   * A cook has no portal on the website — `roleLandingPath` sends the role to
   * `/`, and `/hostel-admin` is a prefix their account is refused at. Their
   * surface is the app. Anything routed here therefore lands on the public
   * site rather than on a guard telling them they are not allowed into the
   * hostel they cook for.
   */
  [Role.COOK]: "/",
  [Role.RESIDENT]: "/resident/notifications",
  [Role.GUARDIAN]: "/guardian/notifications",
  [Role.PUBLIC]: "/community",
};

const FALLBACK_LIST = "/community";

/**
 * Category to path, per portal.
 *
 * Only categories whose portal has a screen for them appear. A missing entry is
 * not an oversight — it means "this role has nowhere better than its own
 * notification list", which is what the lookup falls back to.
 */
const CATEGORY_PATHS: Record<string, Record<string, string>> = {
  [Role.SUPERADMIN]: {
    ACCOUNT_DELETION: "/platform/account-deletions",
    ANNOUNCEMENT: "/platform/inbox",
    BOOKING: "/platform/bookings",
    COMMUNITY: "/community",
    COMPLAINT: "/platform/complaints",
    HOSTEL_APPROVAL: "/platform/hostels",
    INQUIRY: "/platform/inbox",
    PAYMENT: "/platform/transactions",
    REVIEW: "/platform/reviews",
    SERVICE_PROVIDER: "/platform/service-providers",
    STORE_ORDER: "/platform/store",
  },
  [Role.HOSTEL_ADMIN]: {
    ACCOUNT: "/hostel-admin/dashboard",
    ANNOUNCEMENT: "/hostel-admin/notices",
    ATTENDANCE: "/hostel-admin/attendance",
    BOOKING: "/hostel-admin/bookings",
    COMMUNITY: "/community",
    COMPLAINT: "/hostel-admin/complaints",
    ELECTRICIAN: "/hostel-admin/maintenance",
    FOOD: "/hostel-admin/food",
    INQUIRY: "/hostel-admin/inquiries",
    MAINTENANCE: "/hostel-admin/maintenance",
    NIGHT_STATUS: "/hostel-admin/night-status",
    NOTICE: "/hostel-admin/notices",
    PAYMENT: "/hostel-admin/payments",
    PLUMBER: "/hostel-admin/maintenance",
    RESIDENT: "/hostel-admin/residents",
    REVIEW: "/hostel-admin/reports",
    ROOM: "/hostel-admin/rooms",
    SERVICE_PROVIDER: "/hostel-admin/service-providers",
    SOS: "/hostel-admin/sos-alerts",
  },
  [Role.RESIDENT]: {
    ACCOUNT: "/resident/profile",
    ACCOUNT_DELETION: "/resident/settings",
    ANNOUNCEMENT: "/resident/notices",
    ATTENDANCE: "/resident/attendance",
    BOOKING: "/resident/bookings",
    COMMUNITY: "/community",
    COMPLAINT: "/resident/complaints",
    ELECTRICIAN: "/resident/complaints",
    FOOD: "/resident/food",
    GUARDIAN: "/resident/guardians",
    MAINTENANCE: "/resident/complaints",
    NIGHT_STATUS: "/resident/night-status",
    NOTICE: "/resident/notices",
    PAYMENT: "/resident/payments",
    PLUMBER: "/resident/complaints",
    REVIEW: "/resident/reviews",
    ROOM: "/resident/profile",
    SOS: "/resident/sos",
  },
  [Role.GUARDIAN]: {
    ANNOUNCEMENT: "/guardian/notices",
    ATTENDANCE: "/guardian/safety",
    FOOD: "/guardian/food",
    GUARDIAN: "/guardian/dashboard",
    /* A guardian sees where their resident is, not a form to answer. */
    NIGHT_STATUS: "/guardian/safety",
    NOTICE: "/guardian/notices",
    PAYMENT: "/guardian/dashboard",
    SOS: "/guardian/safety",
  },
  // Deliberately empty: see the COOK entry in NOTIFICATION_LIST above.
  [Role.COOK]: {},
  [Role.PUBLIC]: {
    BOOKING: "/bookings",
    COMMUNITY: "/community",
    ELECTRICIAN: "/jobs",
    MAINTENANCE: "/jobs",
    PLUMBER: "/jobs",
    SERVICE_PROVIDER: "/service-providers",
  },
};

/** A warden sees the hostel portal, so it reads the same table as its admin. */
CATEGORY_PATHS[Role.WARDEN] = CATEGORY_PATHS[Role.HOSTEL_ADMIN];
/** A moderator sees the platform portal. */
CATEGORY_PATHS[Role.PLATFORM_MODERATOR] = CATEGORY_PATHS[Role.SUPERADMIN];

function readId(data: Record<string, unknown> | undefined, key: string) {
  const value = data?.[key];

  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * A same-origin path, or nothing.
 *
 * `//evil.example` is protocol-relative: it reads as a local path and resolves
 * to another origin. The service worker turns whatever it is handed into an
 * absolute URL and opens a window on it, so a value that survives this check is
 * a value that gets navigated to.
 */
function samePathOnly(value: string | undefined): string | null {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return null;
  }

  return value;
}

export function webLinkForNotification(input: WebLinkInput): string {
  const role = input.role ?? Role.PUBLIC;
  const table = CATEGORY_PATHS[role] ?? {};
  const list = NOTIFICATION_LIST[role] ?? FALLBACK_LIST;

  /*
   * A reminder about the hostel's own plan bill opens that hostel's Billing
   * page, on the tenant path so it lands in one hop. The PAYMENT default is the
   * rent ledger, which is not where a plan invoice is. Only hostel admins are
   * sent these; anyone else falls through to their own list.
   */
  if (isPlanDueNotification(input) && role === Role.HOSTEL_ADMIN) {
    const slug = readId(input.data, "hostelSlug");

    return slug ? `/${encodeURIComponent(slug)}/admin/billing` : "/hostel-admin/billing";
  }

  /*
   * `STORE_ORDER` is the one exception it already is on mobile: the order
   * detail page is an app screen, and the website has nothing at that path.
   */
  if (input.category !== "STORE_ORDER") {
    const chosen = samePathOnly(input.actionUrl);

    if (chosen) {
      return chosen;
    }
  }

  // A notification about one specific thing opens that thing. The id is only
  // trusted where the category says what it refers to — `data` is written by
  // eighteen different services and is not a stable schema.
  switch (input.category) {
    case "PAYMENT": {
      const invoiceId = readId(input.data, "invoiceId");

      if (invoiceId && role === Role.RESIDENT) {
        return `/resident/payments/${invoiceId}`;
      }

      break;
    }
    case "COMPLAINT": {
      const complaintId = readId(input.data, "complaintId");

      if (complaintId && role === Role.RESIDENT) {
        return `/resident/complaints/${complaintId}`;
      }

      break;
    }
    case "NOTICE":
    case "ANNOUNCEMENT": {
      const noticeId = readId(input.data, "noticeId");

      if (noticeId && role === Role.RESIDENT) {
        return `/resident/notices/${noticeId}`;
      }

      break;
    }
    case "COMMUNITY": {
      const postId = readId(input.data, "postId");

      return postId ? `/community/${postId}` : "/community";
    }
    case "FOOD": {
      /*
       * One category, two audiences — see the same branch in `push-routing.ts`.
       * The copy of "food is ready" written for the hostel's own staff belongs
       * on the kitchen screen, not on a resident menu the account cannot open.
       */
      if (input.data?.audience === "STAFF") {
        return "/hostel-admin/food";
      }

      break;
    }
    default:
      break;
  }

  return table[input.category] ?? list;
}
