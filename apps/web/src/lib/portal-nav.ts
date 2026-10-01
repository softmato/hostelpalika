/**
 * Single source of truth for portal navigation.
 *
 * The sidebar renders these groups directly, and the header command palette
 * searches entries derived from the same tree — so a tab can never exist in one
 * place and be missing from the other.
 */

import { PLATFORM_FIELDS } from "./platform-field-index.generated";

export type PortalIconName =
  | "activity"
  | "bed"
  | "bell"
  | "building"
  | "calendar"
  | "camera"
  | "card"
  | "chart"
  | "clipboard"
  | "dashboard"
  | "file"
  | "flag"
  | "food"
  | "gift"
  | "globe"
  | "help"
  | "layout"
  | "map"
  | "megaphone"
  | "message"
  | "moon"
  | "qr"
  | "receipt"
  | "scroll"
  | "settings"
  | "shield"
  | "siren"
  | "sparkles"
  | "star"
  | "tag"
  | "toggle"
  | "user"
  | "users"
  | "wrench";

export type PortalNavLeaf = {
  badge?: number;
  /** Shown in the command palette result row. */
  description?: string;
  href: string;
  icon?: PortalIconName;
  keywords?: string[];
  label: string;
};

export type PortalNavItem = PortalNavLeaf & {
  children?: PortalNavLeaf[];
};

export type PortalNavGroup = {
  items: PortalNavItem[];
  /** Small uppercase section heading; omit for an unlabelled first block. */
  label?: string;
};

export type PortalSearchEntry = {
  description: string;
  /** A field inside a page (`?field=`), not the page itself. */
  field?: boolean;
  group: string;
  href: string;
  id: string;
  keywords: string[];
  label: string;
};

/* -------------------------------------------------------------------------- */
/* Platform owner                                                             */
/* -------------------------------------------------------------------------- */

export const PLATFORM_NAV: PortalNavGroup[] = [
  {
    items: [
      {
        description:
          "Platform-wide KPIs, approval queue, subscription revenue, and recent audit activity.",
        href: "/platform/dashboard",
        icon: "dashboard",
        keywords: ["home", "overview", "kpi", "metrics", "analytics"],
        label: "Dashboard",
      },
    ],
    label: "Overview",
  },
  {
    items: [
      {
        description:
          "Review submitted hostels — check KYC documents, then approve, reject, request more papers, publish, or unpublish.",
        href: "/platform/hostels",
        icon: "building",
        keywords: [
          "approval",
          "queue",
          "pending",
          "reject",
          "publish",
          "onboarding",
          "kyc",
          "verification",
          "documents",
          "licence",
          "identity",
          "verify",
          "compliance",
        ],
        label: "Hostel Approvals",
      },
      {
        description:
          "Manage live public listings — visibility, featured placement, and listing quality.",
        href: "/platform/listings",
        icon: "globe",
        keywords: ["public", "live", "featured", "visibility", "seo", "ranking"],
        label: "Listings",
      },
      {
        description:
          "Duplicate and ghost-listing reports raised by users or the automated duplicate check.",
        href: "/platform/abuse-flags",
        icon: "flag",
        keywords: ["abuse", "duplicate", "ghost", "spam", "report", "fraud"],
        label: "Abuse Flags",
      },
      {
        /*
         * Public-space posts belong to no hostel, so no hostel admin can reach
         * them. Without this queue they would go unreviewed entirely.
         */
        description:
          "Reported posts from every community space, including posts that belong to no hostel.",
        href: "/platform/community",
        icon: "message",
        keywords: ["community", "posts", "moderation", "reports", "flagged", "abuse"],
        label: "Community Reports",
      },
      {
        description:
          "Paid placements in the community sidebar — colleges, hostels and local businesses, ordered by priority.",
        href: "/platform/sponsors",
        icon: "megaphone",
        keywords: [
          "sponsors",
          "ads",
          "advertising",
          "placement",
          "colleges",
          "priority",
          "campaign",
        ],
        label: "Sponsors",
      },
    ],
    label: "Hostels",
  },
  {
    items: [
      {
        description:
          "Every account on the platform — owners, wardens, residents, and guardians — with room, guardian, fee, and activation detail.",
        href: "/platform/users",
        icon: "users",
        keywords: [
          "accounts",
          "owners",
          "wardens",
          "residents",
          "students",
          "tenants",
          "guardians",
          "roles",
          "activation",
          "directory",
        ],
        label: "Users",
      },
      {
        description:
          "Approve service provider applications, manage the verified provider network, and set the call-out charge per trade.",
        href: "/platform/service-providers",
        icon: "wrench",
        keywords: [
          "providers",
          "vendors",
          "maintenance",
          "electrician",
          "plumber",
          "verify",
          "call-out charges",
          "minimum fee",
          "maintenance charges",
        ],
        label: "Service Providers",
      },
      {
        description:
          "The field team, and every hostel they registered — with what each of them collected.",
        href: "/platform/team",
        icon: "users",
        keywords: [
          "team",
          "agents",
          "field",
          "invite",
          "commission",
          "collected",
          "cash",
        ],
        label: "Team",
      },
    ],
    label: "People",
  },
  {
    items: [
      {
        children: [
          {
            description:
              "Roll-up of resident payments recorded across every hostel, with proof approvals.",
            href: "/platform/payments",
            keywords: ["collection", "due", "proof", "receipt", "esewa", "khalti"],
            label: "Payments",
          },
          {
            description:
              "Immutable ledger of every platform transaction with method, reference, and status.",
            href: "/platform/transactions",
            keywords: ["ledger", "txn", "refund", "settlement", "invoice", "history"],
            label: "Transactions",
          },
          {
            description:
              "Room bookings paid to us: payments to check, hostels to chase, refunds and payouts to send, settings.",
            href: "/platform/bookings",
            keywords: ["booking", "refund", "payout", "hold", "strike", "screenshot"],
            label: "Bookings",
          },
          {
            /*
             * Hostels paying *us*, which is not what the two rows above are.
             * Those are residents paying hostels, one level down, and they
             * share no rows, no merchant of record and no reader with this.
             * Filed under Fees & Payments because it is money, and kept a
             * separate destination because a single screen carrying both
             * would make one of its two totals answer a question nobody asked.
             */
            description:
              "Plan invoices and receipts issued to hostels, what has been collected, and what is still owed.",
            href: "/platform/subscriptions",
            keywords: [
              "subscription",
              "plan",
              "invoice",
              "receipt",
              "billing",
              "softmato",
              "renewal",
              "mrr",
            ],
            label: "Plan Billing",
          },
        ],
        href: "/platform/payments",
        icon: "card",
        label: "Fees & Payments",
      },
      {
        /*
         * The platform's own shop, where hostels buy supplies. Under Finance
         * rather than a section of its own because it is the second thing the
         * platform charges for, and the person who reads the subscription
         * revenue is the person who reads this.
         */
        children: [
          {
            description:
              "Products, the departments they sit in, and what delivery costs.",
            href: "/platform/store",
            keywords: ["catalogue", "products", "inventory", "stock", "shop", "mart"],
            label: "Catalogue",
          },
          {
            description:
              "Supply orders placed by hostels - confirm, pack, ship and mark delivered.",
            href: "/platform/store/orders",
            keywords: ["orders", "fulfilment", "delivery", "cod", "shipping", "packing"],
            label: "Store Orders",
          },
        ],
        href: "/platform/store",
        icon: "tag",
        label: "Supply Store",
      },
      {
        description:
          "Certified residents each quarter, the perk catalogue, and the offers given — fee off or a gift from HostelPalika.",
        href: "/platform/offer-program",
        icon: "sparkles",
        keywords: ["offer", "program", "perks", "rewards", "gift", "fee off", "certified", "quarter"],
        label: "Offer Program",
      },
      {
        description:
          "Hostels that registered with a code, partner codes for marketing with their commission, and the extra plan time each side gets.",
        href: "/platform/referrals",
        icon: "users",
        keywords: ["referral", "refer", "invite", "partner", "marketing", "commission", "code", "link"],
        label: "Referral settings",
      },
    ],
    label: "Finance",
  },
  {
    items: [
      {
        description:
          "Moderate resident ratings and reviews; hide abusive or fake content.",
        href: "/platform/reviews",
        icon: "star",
        keywords: ["ratings", "moderation", "hide", "feedback", "stars"],
        label: "Reviews",
      },
      {
        description:
          "Escalated complaints across hostels that need platform-level oversight.",
        href: "/platform/complaints",
        icon: "message",
        keywords: ["complaint", "escalation", "grievance", "sla", "resolution"],
        label: "Complaints",
      },
    ],
    label: "Moderation",
  },
  {
    items: [
      {
        description:
          "Site identity, homepage hero copy, headline stats, and trust points shown to the public.",
        href: "/platform/config/site",
        icon: "layout",
        keywords: ["homepage", "hero", "brand", "tagline", "stats", "trust", "content"],
        label: "Site Content",
      },
      {
        description:
          "Cities and areas offered in public search filters and the hostel registration form.",
        href: "/platform/config/locations",
        icon: "map",
        keywords: ["cities", "areas", "kathmandu", "pokhara", "filters", "locations"],
        label: "Locations",
      },
      {
        description:
          "Facility and amenity catalogue used by listings, filters, and comparison.",
        href: "/platform/config/facilities",
        icon: "sparkles",
        keywords: ["amenities", "wifi", "facilities", "features", "filters", "catalogue"],
        label: "Facilities",
      },
      {
        /**
         * The `/plans-pricing` catalogue, edited on a rendering of the page
         * itself. Distinct from "Pricing Cards" below it, which is the older,
         * flat three-card `pricing` section still serving `/pricing` and the
         * app's Pricing screen.
         */
        description:
          "The Plans & Pricing catalogue — tiers, prices and discounts, every module and service, and the walkthrough clips on their pages.",
        href: "/platform/config/plans",
        icon: "tag",
        keywords: [
          "plans",
          "pricing",
          "tiers",
          "discount",
          "annual",
          "modules",
          "services",
          "catalogue",
          "walkthrough",
          "video",
        ],
        label: "Plans & Pricing",
      },
      {
        description: "Site-wide announcement banner shown above the public header.",
        href: "/platform/config/announcements",
        icon: "megaphone",
        keywords: ["banner", "announcement", "notice", "alert", "marketing"],
        label: "Announcements",
      },
      {
        description:
          "Privacy, terms, About, FAQ and landing-page copy — shared by the website and the mobile app.",
        href: "/platform/config/content",
        icon: "file",
        keywords: [
          "content",
          "copy",
          "about",
          "faq",
          "privacy",
          "terms",
          "text",
          "wording",
        ],
        label: "Page Content",
      },
      {
        description:
          "Search titles and descriptions for every page, Search Console verification, and the pages written to be found — software, features and comparisons.",
        href: "/platform/config/seo",
        icon: "globe",
        keywords: [
          "seo",
          "google",
          "search console",
          "bing",
          "meta",
          "title",
          "description",
          "keywords",
          "ranking",
        ],
        label: "SEO",
      },
      {
        description:
          "Terms of service and privacy policy content served on the public site.",
        href: "/platform/config/legal",
        icon: "scroll",
        keywords: ["terms", "privacy", "policy", "legal", "compliance"],
        label: "Legal Pages",
      },
      {
        description:
          "Toggle public surfaces — inquiries, comparison, service provider signup, registration.",
        href: "/platform/config/features",
        icon: "toggle",
        keywords: ["flags", "toggle", "enable", "disable", "kill switch", "rollout"],
        label: "Feature Flags",
      },
    ],
    label: "Website Config",
  },
  {
    items: [
      {
        description:
          "Send a push notification to phones and browsers — heading, message and urgency.",
        href: "/platform/push",
        icon: "bell",
        keywords: ["push", "notification", "broadcast", "notify", "alert", "send", "urgent"],
        label: "Push Notification",
      },
      {
        description:
          "Operational reports across hostels, revenue, occupancy, and complaints.",
        href: "/platform/reports",
        icon: "chart",
        keywords: ["report", "export", "analytics", "csv", "insights"],
        label: "Reports",
      },
      {
        description:
          "Hostel owners asking to close their account. Nothing happens until you approve.",
        href: "/platform/account-deletions",
        icon: "clipboard",
        keywords: [
          "delete",
          "deletion",
          "account",
          "close account",
          "erase",
          "privacy",
          "gdpr",
        ],
        label: "Account Deletions",
      },
      {
        description: "Immutable trail of every privileged action taken on the platform.",
        href: "/platform/audit-logs",
        icon: "clipboard",
        keywords: ["audit", "trail", "history", "log", "who did what", "security"],
        label: "Audit Log",
      },
      {
        description:
          "Platform owner account, access controls, and the operations knobs — SLAs, reminder timings, and the field collection QR.",
        href: "/platform/settings",
        icon: "settings",
        keywords: [
          "settings",
          "account",
          "password",
          "profile",
          "preferences",
          // The operations panel lives inside this page rather than on a route
          // of its own, so the things it configures have to be searchable from
          // here or they are only findable by scrolling.
          "operations",
          "qr",
          "collection qr",
          "field collection",
          "receipt prefix",
          "sla",
          "reminders",
        ],
        label: "Settings",
      },
    ],
    label: "System",
  },
];

/* -------------------------------------------------------------------------- */
/* Hostel admin / warden                                                      */
/* -------------------------------------------------------------------------- */

export const HOSTEL_ADMIN_NAV: PortalNavGroup[] = [
  {
    items: [
      {
        description:
          "Occupancy, collections, open complaints, and today's operational summary.",
        href: "/hostel-admin/dashboard",
        icon: "dashboard",
        keywords: ["home", "overview", "summary", "today"],
        label: "Dashboard",
      },
      {
        description:
          "Public hostel profile — photos, facilities, rules, pricing, and contact.",
        href: "/hostel-admin/profile",
        icon: "building",
        keywords: ["profile", "listing", "photos", "facilities", "rules"],
        label: "Hostel Profile",
      },
      {
        description: "Photos, documents, payouts, payments and food — finish them to unlock everything.",
        href: "/hostel-admin/kyc",
        icon: "shield",
        keywords: ["kyc", "verify", "documents", "complete", "setup", "progress"],
        label: "Hostel KYC",
      },
      {
        description:
          "Other buildings you run under this hostel's plan — add one, and switch between them.",
        href: "/hostel-admin/branches",
        icon: "building",
        keywords: ["branch", "branches", "second hostel", "another building", "switch hostel", "pan"],
        label: "Branches",
      },
      {
        description: "Room and bed map with vacancy and repair status.",
        href: "/hostel-admin/rooms",
        icon: "bed",
        keywords: ["rooms", "beds", "vacancy", "map", "allocation"],
        label: "Rooms & Beds",
      },
    ],
  },
  {
    items: [
      {
        description: "Resident directory, activation codes, guardians, and fee status.",
        href: "/hostel-admin/residents",
        icon: "users",
        keywords: ["residents", "tenants", "students", "activation", "guardian", "existing residents", "excel", "upload list", "join link", "join requests", "whatsapp link"],
        label: "Residents",
      },
      {
        description: "Warden accounts, permissions, and activity for this hostel.",
        href: "/hostel-admin/wardens",
        icon: "shield",
        keywords: ["warden", "staff", "permissions", "team"],
        label: "Wardens",
      },
      {
        description: "Beds booked through the platform: confirm or decline, held beds, and your share.",
        href: "/hostel-admin/bookings",
        icon: "calendar",
        keywords: ["booking", "reserve", "hold", "confirm", "decline", "payout"],
        label: "Bookings",
      },
      {
        description: "Public inquiries from prospective residents with notes and status.",
        href: "/hostel-admin/inquiries",
        icon: "message",
        keywords: ["inquiry", "leads", "visit", "enquiry", "prospect"],
        label: "Inquiries",
      },
      {
        description:
          "Move-in and move-out checklists, provided items, and deposit refunds.",
        href: "/hostel-admin/move-in-out",
        icon: "clipboard",
        keywords: ["move in", "move out", "checklist", "deposit", "refund", "handover"],
        label: "Move-In / Move-Out",
      },
    ],
    label: "Residents",
  },
  {
    items: [
      {
        children: [
          {
            description: "Record payments, approve proofs, and track dues per resident.",
            href: "/hostel-admin/payments",
            keywords: ["payment", "collection", "proof", "receipt", "due"],
            label: "Payments",
          },
          {
            description:
              "The rate card every invoice is computed from, by bed type, with history.",
            href: "/hostel-admin/fee-schedule",
            keywords: [
              "fee",
              "rent",
              "rate card",
              "schedule",
              "deposit",
              "charges",
              "pricing",
            ],
            label: "Fee Schedule",
          },
          {
            description:
              "Upload your wallet or bank statement and settle the month against what arrived.",
            href: "/hostel-admin/reconcile",
            keywords: [
              "reconcile",
              "statement",
              "esewa",
              "khalti",
              "bank",
              "csv",
              "import",
              "unmatched",
            ],
            label: "Reconcile",
          },
          {
            description:
              "Your QR, wallet IDs and bank account — what residents see when they pay.",
            href: "/hostel-admin/payment-setup",
            keywords: ["qr", "esewa", "khalti", "bank", "account", "payment setup"],
            label: "Payment Setup",
          },
          {
            description:
              "Let residents pay in one tap through eSewa or Khalti — settles itself, no approval queue.",
            href: "/hostel-admin/payment-gateways",
            keywords: [
              "esewa",
              "khalti",
              "fonepay",
              "gateway",
              "online",
              "checkout",
              "merchant",
            ],
            label: "Online Checkout",
          },
          {
            description:
              "Full payment ledger with method, reference, and reconciliation status.",
            href: "/hostel-admin/transactions",
            keywords: ["ledger", "transaction", "history", "reconcile", "refund"],
            label: "Transactions",
          },
        ],
        href: "/hostel-admin/payments",
        icon: "card",
        label: "Fees & Payments",
      },
    ],
    label: "Finance",
  },
  {
    items: [
      {
        description: "Daily menu, meal photos, and resident food feedback.",
        href: "/hostel-admin/food",
        icon: "food",
        keywords: ["food", "menu", "meal", "kitchen", "feedback"],
        label: "Food & Menu",
      },
      {
        description: "Who is in tonight, manual overrides, and absence follow-up.",
        href: "/hostel-admin/night-status",
        icon: "moon",
        keywords: ["attendance", "night", "roll call", "inside", "outside", "safety"],
        label: "Night Status",
      },
      {
        description: "Publish notices to residents and track read status.",
        href: "/hostel-admin/notices",
        icon: "megaphone",
        keywords: ["notice", "announcement", "circular", "broadcast"],
        label: "Notices",
      },
      {
        description:
          "Resident complaints with updates, attachments, and resolution flow.",
        href: "/hostel-admin/complaints",
        icon: "message",
        keywords: ["complaint", "issue", "ticket", "resolve"],
        label: "Complaints",
      },
      {
        description:
          "Raise repair requests with an auto-suggested provider role, assign verified providers, and track history.",
        href: "/hostel-admin/maintenance",
        icon: "wrench",
        keywords: [
          "maintenance",
          "repair",
          "ticket",
          "electrical",
          "plumbing",
          "provider",
          "vendor",
          "electrician",
          "plumber",
          "book visit",
        ],
        label: "Maintenance & Providers",
      },
      {
        description: "Live SOS alerts raised by residents with escalation history.",
        href: "/hostel-admin/sos-alerts",
        icon: "siren",
        keywords: ["sos", "emergency", "alert", "panic", "safety"],
        label: "SOS Alerts",
      },
      {
        description:
          "Zone-based attendance for today, absence alerts, and manual overrides.",
        href: "/hostel-admin/attendance",
        icon: "clipboard",
        keywords: ["attendance", "location", "geofence", "absent", "present"],
        label: "Attendance",
      },
      {
        /*
         * Not a feed — the feed itself lives at `/community` and is reached
         * from the header. What stays in the portal is the queue of this
         * hostel's posts that people reported.
         */
        description: "Review reported posts from your hostel and post announcements.",
        href: "/hostel-admin/community",
        icon: "flag",
        keywords: ["community", "feed", "posts", "moderation", "reports", "flagged"],
        label: "Community Reports",
      },
    ],
    label: "Operations",
  },
  {
    items: [
      {
        description: "Referral codes, joined referrals, and reward payouts.",
        href: "/hostel-admin/referrals",
        icon: "gift",
        keywords: ["referral", "reward", "invite", "code"],
        label: "Referrals",
      },
      {
        description:
          "Your hostel's referral code and link. Another hostel that registers with it gets extra plan time, and so do you.",
        href: "/hostel-admin/invite-hostels",
        icon: "megaphone",
        keywords: ["invite", "hostel", "refer", "referral", "friend", "whatsapp", "share", "free month"],
        label: "Invite hostels",
      },
      {
        description:
          "Compose targeted or scheduled notifications and track delivery and read counts.",
        href: "/hostel-admin/notifications",
        icon: "bell",
        keywords: ["notification", "alert", "broadcast", "push", "schedule", "announce"],
        label: "Notifications",
      },
      {
        description: "Occupancy, collection, complaint, and maintenance reports.",
        href: "/hostel-admin/reports",
        icon: "chart",
        keywords: ["report", "analytics", "export", "insights"],
        label: "Reports",
      },
      {
        description:
          "Your plan invoices and receipts from Softmato, and what is outstanding.",
        href: "/hostel-admin/billing",
        icon: "receipt",
        keywords: [
          "billing",
          "plan",
          "subscription",
          "invoice",
          "receipt",
          "softmato",
        ],
        label: "Plan billing",
      },
      {
        description: "Hostel workspace controls for profile, resident access, and staff.",
        href: "/hostel-admin/settings",
        icon: "settings",
        keywords: [
          "settings",
          "preferences",
          "access",
          "workspace",
          "temporary",
          "login",
          "share",
        ],
        label: "Settings",
      },
    ],
    label: "Growth & System",
  },
];

/* -------------------------------------------------------------------------- */
/* Resident + guardian                                                        */
/* -------------------------------------------------------------------------- */

export const RESIDENT_NAV: PortalNavGroup[] = [
  {
    items: [
      { href: "/resident/dashboard", icon: "dashboard", label: "Dashboard" },
      { href: "/resident/profile", icon: "user", label: "My Profile" },
      // The public booking pages: a resident who booked before moving in finds its receipt here.
      { href: "/bookings", icon: "calendar", keywords: ["booking", "refund"], label: "My Bookings" },
    ],
  },
  {
    items: [
      {
        href: "/resident/payments",
        icon: "card",
        keywords: ["due", "rent", "upload", "receipt", "esewa", "proof"],
        label: "Fees & Payments",
      },
      {
        // Its own entry rather than a tab inside Fees & Payments: a resident
        // opens that page to *do* something about a due date, and the
        // programme's own view is what they open when they want to see what
        // their codes and receipts add up to. Two errands, two destinations.
        href: "/resident/offer-program",
        icon: "sparkles",
        keywords: [
          "offer",
          "program",
          "reference",
          "code",
          "certified",
          "receipt",
          "membership",
        ],
        label: "Offer Program",
      },
      { href: "/resident/food", icon: "food", label: "Food Menu" },
      // No Community entry: it is one platform-wide room at `/community`,
      // linked from the portal header instead of each portal's sidebar.
      { href: "/resident/notices", icon: "megaphone", label: "Notices" },
    ],
    label: "Daily",
  },
  {
    items: [
      { href: "/resident/complaints", icon: "message", label: "Complaints" },
      { href: "/resident/night-status", icon: "moon", label: "Night Status" },
      {
        href: "/resident/attendance",
        icon: "clipboard",
        keywords: ["location", "tracking", "consent", "present", "absent"],
        label: "Attendance",
      },
      { href: "/resident/sos", icon: "siren", label: "SOS" },
      {
        href: "/resident/guardians",
        icon: "shield",
        keywords: ["parent", "family", "access", "permissions"],
        label: "Guardians",
      },
      { href: "/resident/reviews", icon: "star", label: "Reviews" },
    ],
    label: "Safety & Feedback",
  },
  {
    items: [
      { href: "/resident/referral", icon: "gift", label: "Referral" },
      { href: "/resident/notifications", icon: "bell", label: "Notifications" },
      {
        href: "/resident/settings",
        icon: "settings",
        keywords: ["settings", "access", "temporary", "login", "password", "share"],
        label: "Settings",
      },
    ],
    label: "Account",
  },
];

export const GUARDIAN_NAV: PortalNavGroup[] = [
  {
    items: [
      { href: "/guardian/dashboard", icon: "receipt", label: "Fee Summary" },
      { href: "/guardian/notices", icon: "megaphone", label: "Notices" },
      { href: "/guardian/food", icon: "food", label: "Food View" },
    ],
  },
  {
    items: [
      { href: "/guardian/safety", icon: "shield", label: "Safety Summary" },
      { href: "/guardian/emergency-contact", icon: "siren", label: "Emergency Contact" },
    ],
    label: "Safety",
  },
  {
    items: [{ href: "/guardian/notifications", icon: "bell", label: "Notifications" }],
    label: "Account",
  },
];

/** The cook app's tabs, on the web. Community sits in the shell header. */
export const COOK_NAV: PortalNavGroup[] = [
  {
    items: [
      { href: "/cook", icon: "food", keywords: ["food ready", "announce", "meal"], label: "Today" },
      { href: "/cook/menu", icon: "calendar", keywords: ["week", "routine"], label: "Menu" },
      { href: "/cook/photos", icon: "camera", keywords: ["upload", "picture"], label: "Photos" },
      { href: "/cook/notifications", icon: "bell", label: "Notifications" },
    ],
  },
];

/** The provider app's tabs, on the web. */
export const PROVIDER_NAV: PortalNavGroup[] = [
  {
    items: [
      { href: "/jobs", icon: "wrench", keywords: ["work", "maintenance"], label: "Jobs" },
      { href: "/jobs/card", icon: "card", keywords: ["profile", "application", "id"], label: "My card" },
      { href: "/jobs/notifications", icon: "bell", label: "Notifications" },
    ],
  },
];

/* -------------------------------------------------------------------------- */
/* Search                                                                     */
/* -------------------------------------------------------------------------- */

function toId(href: string) {
  return href.replace(/^\//, "").replaceAll("/", "-");
}

/**
 * Flattens the nav tree into palette entries. Parents that only exist to hold
 * children (no description of their own) are skipped so the palette lists the
 * real destinations rather than the accordion header.
 */
export function searchEntriesFromNav(groups: PortalNavGroup[]): PortalSearchEntry[] {
  const entries: PortalSearchEntry[] = [];
  const seen = new Set<string>();

  function push(leaf: PortalNavLeaf, group: string, parentLabel?: string) {
    if (seen.has(leaf.href)) return;
    seen.add(leaf.href);
    entries.push({
      description: leaf.description ?? `Open ${leaf.label}.`,
      group: parentLabel ? `${group} › ${parentLabel}` : group,
      href: leaf.href,
      id: toId(leaf.href),
      keywords: leaf.keywords ?? [],
      label: leaf.label,
    });
  }

  for (const group of groups) {
    const groupLabel = group.label ?? "General";

    for (const item of group.items) {
      if (item.children && item.children.length > 0) {
        for (const child of item.children) {
          push(child, groupLabel, item.label);
        }
        continue;
      }

      push(item, groupLabel);
    }
  }

  return entries;
}

/* -------------------------------------------------------------------------- */
/* Field team                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Two destinations, and that is the point.
 *
 * An agent's whole job is filing hostels and collecting the first payment, so
 * the portal is a desk rather than an administration console. Every other
 * platform screen — moderation, config, users, the store — is deliberately
 * absent: an agent handles cash in the field, and the smaller the surface their
 * login opens, the less a lost phone costs.
 */
export const TEAM_NAV: PortalNavGroup[] = [
  {
    items: [
      {
        description: "Hostels you have registered, and what they still owe.",
        href: "/team",
        icon: "dashboard",
        keywords: ["dashboard", "home", "registrations"],
        label: "My desk",
      },
      {
        description: "Register a hostel and take the first payment.",
        href: "/team/register",
        icon: "building",
        keywords: ["new", "register", "hostel", "add"],
        label: "Register a hostel",
      },
    ],
  },
];

export const TEAM_SEARCH_ENTRIES = searchEntriesFromNav(TEAM_NAV);

/** Lowercase words joined by dashes: how a field's label travels in `?field=`. */
export function fieldSlug(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Every field on the config screens as a palette entry that opens its page on
 * its tab with the field focused. Built from the page entries it is given, so a
 * page the viewer cannot open (moderators) takes its fields with it.
 */
function withFieldEntries(pages: PortalSearchEntry[]): PortalSearchEntry[] {
  const pageLabels = new Map(pages.map((page) => [page.href, page.label]));
  const fields = PLATFORM_FIELDS.flatMap((field) => {
    const page = pageLabels.get(field.href);
    if (!page) return [];

    const query = new URLSearchParams();
    if (field.tab) query.set("tab", field.tab);
    query.set("field", fieldSlug(field.label));
    if (field.section) query.set("in", fieldSlug(field.section));
    const href = `${field.href}?${query}`;
    const tab = field.tab && field.tab[0].toUpperCase() + field.tab.slice(1);

    return [
      {
        description: [tab, field.section].filter(Boolean).join(" › ") || page,
        field: true,
        group: page,
        href,
        id: toId(href),
        keywords: [],
        label: field.label,
      },
    ];
  });

  return [...pages, ...fields];
}

export const PLATFORM_SEARCH_ENTRIES = withFieldEntries(searchEntriesFromNav(PLATFORM_NAV));

/**
 * Destinations a PLATFORM_MODERATOR ("acting superadmin") may not open, kept in
 * step with the superadmin-only rules in `route-access.ts`. Hiding them is a
 * courtesy — the route rule and the API guard are what actually enforce it.
 */
const SUPERADMIN_ONLY_PREFIXES = [
  "/platform/account-deletions",
  "/platform/bookings",
  "/platform/config",
  "/platform/offer-program",
  "/platform/push",
  "/platform/referrals",
  "/platform/settings",
];

function isSuperadminOnlyHref(href: string) {
  return SUPERADMIN_ONLY_PREFIXES.some(
    (prefix) => href === prefix || href.startsWith(`${prefix}/`),
  );
}

/** Drops superadmin-only entries, then any group or parent left with nothing. */
function withoutSuperadminOnly(groups: PortalNavGroup[]): PortalNavGroup[] {
  return groups
    .map((group) => ({
      ...group,
      items: group.items
        .map((item) => ({
          ...item,
          children: item.children?.filter((child) => !isSuperadminOnlyHref(child.href)),
        }))
        .filter((item) => {
          if (item.children) {
            return item.children.length > 0;
          }

          return !isSuperadminOnlyHref(item.href);
        }),
    }))
    .filter((group) => group.items.length > 0);
}

export const PLATFORM_MODERATOR_NAV = withoutSuperadminOnly(PLATFORM_NAV);
export const PLATFORM_MODERATOR_SEARCH_ENTRIES = withFieldEntries(
  searchEntriesFromNav(PLATFORM_MODERATOR_NAV),
);
export const HOSTEL_ADMIN_SEARCH_ENTRIES = searchEntriesFromNav(HOSTEL_ADMIN_NAV);
export const RESIDENT_SEARCH_ENTRIES = searchEntriesFromNav(RESIDENT_NAV);
export const GUARDIAN_SEARCH_ENTRIES = searchEntriesFromNav(GUARDIAN_NAV);
export const COOK_SEARCH_ENTRIES = searchEntriesFromNav(COOK_NAV);
export const PROVIDER_SEARCH_ENTRIES = searchEntriesFromNav(PROVIDER_NAV);

/* -------------------------------------------------------------------------- */
/* Tenant-scoped hostel admin URLs                                            */
/* -------------------------------------------------------------------------- */

export const LEGACY_HOSTEL_ADMIN_PREFIX = "/hostel-admin";

/** `/hostel-admin/payments` → `/green-view-hostel/admin/payments`. */
export function hostelAdminHref(slug: string, href: string) {
  if (!href.startsWith(LEGACY_HOSTEL_ADMIN_PREFIX)) {
    return href;
  }

  return `/${slug}/admin${href.slice(LEGACY_HOSTEL_ADMIN_PREFIX.length)}`;
}

/** The same nav tree, pointed at one hostel's workspace. */
export function hostelAdminNavForSlug(slug: string): PortalNavGroup[] {
  return HOSTEL_ADMIN_NAV.map((group) => ({
    ...group,
    items: group.items.map((item) => ({
      ...item,
      children: item.children?.map((child) => ({
        ...child,
        href: hostelAdminHref(slug, child.href),
      })),
      href: hostelAdminHref(slug, item.href),
    })),
  }));
}
