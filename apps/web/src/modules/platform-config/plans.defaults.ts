import type { PlansConfig, PlanService } from "./site-config.validation";

import { DEFAULT_SERVICE_EXPLAINERS } from "./plans-explainers.defaults";

/**
 * The shipped Plans & Pricing catalogue — the default value of the `plans`
 * config section.
 *
 * This was `apps/web/src/app/_components/plans-catalog.ts`, whose own doc
 * comment set out the condition for moving it: *when the owner needs to edit
 * tiers without a deploy, the config section grows to hold this shape — plans
 * keyed by id, services keyed by slug*. It does now, so the data lives here and
 * the component file keeps only the arithmetic that reads it.
 *
 * Nothing on this page is written twice: the three tiers, the nine modules and
 * every service under them are declared once, and the plan cards, the detail
 * pages, the badge pages and the sitemap all project from that.
 *
 * ### Prices
 *
 * One figure per tier — `monthly` — and a percentage off for each longer
 * commitment. Six-month and annual totals are derived (`cycleTotal`), never
 * stored, so the price on the card and the saving advertised beside it cannot
 * drift apart. The shipped percentages are the ones the launch pricing implied,
 * rounded to whole numbers that divide cleanly back into a monthly rate.
 */

/** Cheapest first: card order and "everything in X" chaining both follow this. */
const PLAN_TIERS: PlansConfig["plans"] = [
  {
    annualDiscountPercent: 17,
    ctaHref: "/register-hostel",
    ctaLabel: "Start with Go",
    description: "A single hostel with room to grow into.",
    featured: false,
    eventDiscountPercent: 0,
    freeMonths: 6,
    halfYearlyDiscountPercent: 8,
    id: "go",
    listingTier: null,
    maxBranches: 0,
    maxResidents: 50,
    monthly: 999,
    name: "Go",
    portalAccess: { cooks: 1, wardens: 1 },
  },
  {
    annualDiscountPercent: 14,
    ctaHref: "/register-hostel",
    ctaLabel: "Get Pro",
    description: "A full house, or two floors of one.",
    featured: true,
    eventDiscountPercent: 0,
    freeMonths: 4,
    halfYearlyDiscountPercent: 7,
    id: "pro",
    listingTier: {
      label: "Platinum hostel",
      note: "Ranked above unbadged listings across search, the map and Compare.",
      slug: "platinum-hostel",
      tone: "platinum",
    },
    maxBranches: 0,
    maxResidents: 100,
    monthly: 1_699,
    name: "Pro",
    portalAccess: { cooks: 3, wardens: 2 },
  },
  {
    annualDiscountPercent: 11,
    ctaHref: "/register-hostel",
    ctaLabel: "Upgrade to Max",
    description: "Large hostels and multi-property operators.",
    featured: false,
    eventDiscountPercent: 0,
    freeMonths: 3,
    halfYearlyDiscountPercent: 5,
    id: "max",
    listingTier: {
      label: "Gold hostel",
      note: "Ranked above unbadged listings across search, the map and Compare.",
      slug: "gold-hostel",
      tone: "gold",
    },
    maxBranches: 3,
    maxResidents: null,
    monthly: 2_499,
    name: "Max",
    portalAccess: { cooks: null, wardens: null },
  },
];

/** Icons are slugs resolved by `contentIcon()` — see `contentSchema`'s note. */
const PLAN_MODULES: PlansConfig["modules"] = [
  {
    description: "Who lives here, which bed they hold, and how they arrive and leave.",
    icon: "users",
    id: "residents-rooms",
    name: "Residents & Rooms",
  },
  {
    description: "The rate card, the month's invoices, and the money that comes back.",
    icon: "wallet",
    id: "fees-payments",
    name: "Fees & Payments",
  },
  {
    description: "What is cooked, when it is ready, and what people thought of it.",
    icon: "utensils",
    id: "food-kitchen",
    name: "Food & Kitchen",
  },
  {
    description: "Who is in tonight, and what happens when something goes wrong.",
    icon: "shield-check",
    id: "attendance-safety",
    name: "Attendance & Safety",
  },
  {
    description: "Notices out, complaints in, and nothing sitting unread.",
    icon: "bell",
    id: "communication",
    name: "Communication",
  },
  {
    description: "Broken things reported, assigned and closed.",
    icon: "wrench",
    id: "maintenance",
    name: "Maintenance",
  },
  {
    description: "What a parent can see, and everything they cannot.",
    icon: "user-round",
    id: "guardian",
    name: "Guardian Portal",
  },
  {
    description: "Being found, being compared, and being chosen.",
    icon: "building",
    id: "listing-growth",
    name: "Listing & Growth",
  },
  {
    description: "The numbers behind the month, and who changed what.",
    icon: "file-text",
    id: "reporting",
    name: "Reporting & Control",
  },
];

/**
 * The services, without their prose. The what/how/why is folded in below from
 * `plans-explainers.defaults.ts`, which is kept as its own file for the same
 * reason it always was: the structure is read on every render of the pricing
 * page, and the writing is only ever needed by one detail page.
 */
type PlanServiceSeed = Omit<PlanService, "demo" | "how" | "what" | "why">;

const PLAN_SERVICES: PlanServiceSeed[] = [
  // Residents & Rooms
  {
    audience: ["Hostel admin", "Warden"],
    blurb: "Every resident, their room, their guardian and their history in one list.",
    module: "residents-rooms",
    name: "Resident Management",
    plan: "go",
    slug: "resident-directory",
  },
  {
    audience: ["Hostel admin", "Warden"],
    blurb: "Rooms, beds and vacancies as a map you allocate from.",
    module: "residents-rooms",
    name: "Room & Bed Map",
    plan: "go",
    slug: "room-bed-map",
  },
  {
    audience: ["Hostel admin", "Resident"],
    blurb: "Admission fee and security deposit raised as one invoice on joining.",
    module: "residents-rooms",
    name: "Joining Bill",
    plan: "go",
    slug: "admissions",
  },
  {
    audience: ["Resident", "Warden"],
    blurb:
      "A resident registered once and carried as a QR card a warden scans at the gate.",
    module: "residents-rooms",
    name: "Register Resident with QR Code",
    plan: "go",
    slug: "resident-id-cards",
  },
  {
    audience: ["Hostel admin", "Warden"],
    blurb: "The handover list for a room, ticked on the way in and on the way out.",
    module: "residents-rooms",
    name: "Move-in & Move-out Checks",
    plan: "go",
    slug: "move-checklist",
  },
  {
    audience: ["Hostel admin", "Warden"],
    blurb: "Staff accounts holding only the parts of the portal their job needs.",
    module: "residents-rooms",
    name: "Staff Accounts & Roles",
    plan: "pro",
    slug: "warden-roles",
  },
  {
    audience: ["Hostel admin", "Resident", "Guardian"],
    blurb:
      "The joining agreement read and signed on the resident's phone, and kept against their record.",
    module: "residents-rooms",
    name: "Digital Admission Agreements",
    plan: "max",
    slug: "admission-agreements",
  },
  // Fees & Payments
  {
    audience: ["Hostel admin"],
    blurb: "One rent per room type. The listing and every invoice read from it.",
    module: "fees-payments",
    name: "Room Rent & Records",
    plan: "go",
    slug: "rate-card",
  },
  {
    audience: ["Hostel admin", "Resident"],
    blurb:
      "Invoices raised automatically each month, with the receipt and the running balance against each resident.",
    module: "fees-payments",
    name: "Billing & Payment Tracking",
    plan: "go",
    slug: "monthly-invoicing",
  },
  {
    audience: ["Hostel admin"],
    blurb:
      "A payment screenshot read, checked against the invoice, and flagged if it lies.",
    module: "fees-payments",
    name: "Payment Proof Checks",
    plan: "go",
    slug: "payment-evidence",
  },
  {
    audience: ["Hostel admin"],
    blurb: "The wallet statement matched line by line against what the portal recorded.",
    module: "fees-payments",
    name: "Wallet Statement Matching",
    plan: "pro",
    slug: "reconciliation",
  },
  {
    audience: ["Hostel admin"],
    blurb: "Collections, dues and arrears for a month, exportable.",
    module: "fees-payments",
    name: "Financial Reports & Statements",
    plan: "pro",
    slug: "finance-reports",
  },
  {
    audience: ["Resident", "Hostel admin"],
    blurb: "Residents who pay on time and bring a friend earn against next month.",
    module: "fees-payments",
    name: "Discounts & Referrals",
    plan: "pro",
    slug: "offer-program",
  },
  {
    audience: ["Hostel admin", "Resident", "Guardian"],
    blurb:
      "Unpaid invoices chased on a schedule you set, escalating from the resident to their guardian.",
    module: "fees-payments",
    name: "Automatic Dues Chasing",
    plan: "max",
    slug: "dues-chasing",
  },
  // Food & Kitchen
  {
    audience: ["Resident", "Cook"],
    blurb: "The week's menu, published once and readable on every phone.",
    module: "food-kitchen",
    name: "Food Menu",
    plan: "go",
    slug: "food-menu",
  },
  {
    audience: ["Cook"],
    blurb: "The kitchen's own screen — today's menu, the ready log and stock alerts.",
    module: "food-kitchen",
    name: "Cook Portal",
    plan: "go",
    slug: "cook-portal",
  },
  {
    audience: ["Resident"],
    blurb: "What residents thought of the meal, per meal, not once a year.",
    module: "food-kitchen",
    name: "Meal Ratings",
    plan: "go",
    slug: "meal-feedback",
  },
  // Attendance & Safety
  {
    audience: ["Resident", "Warden", "Guardian"],
    blurb:
      "Inside or outside once a day, and who is in tonight. Coordinates are never stored.",
    module: "attendance-safety",
    name: "Daily Attendance & Night Status",
    plan: "go",
    slug: "daily-attendance",
  },
  {
    audience: ["Resident", "Warden", "Guardian"],
    blurb: "One press from the resident's header reaches staff and guardians at once.",
    module: "attendance-safety",
    name: "Emergency SOS",
    plan: "go",
    slug: "sos-alerts",
  },
  // Communication
  {
    audience: ["Hostel admin", "Resident", "Guardian"],
    blurb: "Notices out, complaints and enquiries in, each with a status and an owner.",
    module: "communication",
    name: "Notices, Complaints & Enquiries",
    plan: "go",
    slug: "notices",
  },
  {
    audience: ["Hostel admin", "Resident", "Guardian"],
    blurb: "Panels that update themselves, and a push when the app is shut.",
    module: "communication",
    name: "Push Notifications",
    plan: "pro",
    slug: "notifications",
  },
  // Maintenance
  {
    audience: ["Resident", "Hostel admin"],
    blurb: "A fault raised with a photo, assigned, and closed when it is fixed.",
    module: "maintenance",
    name: "Repair Requests",
    plan: "go",
    slug: "maintenance-requests",
  },
  {
    audience: ["Resident", "Service provider"],
    blurb: "Say what is broken instead of typing it. Nothing is transcribed.",
    module: "maintenance",
    name: "Voice Notes",
    plan: "go",
    slug: "voice-notes",
  },
  {
    audience: ["Hostel admin", "Service provider"],
    blurb: "Verified plumbers, electricians and carpenters, reachable from the ticket.",
    module: "maintenance",
    name: "Verified Repair Workers",
    plan: "pro",
    slug: "provider-network",
  },
  // Guardian Portal
  {
    audience: ["Guardian", "Resident"],
    blurb: "A parent's own login, linked to their ward and nobody else's.",
    module: "guardian",
    name: "Parent Login",
    plan: "go",
    slug: "guardian-accounts",
  },
  // Listing & Growth
  {
    audience: ["Hostel admin"],
    blurb: "Your hostel's public page — photos, rooms, rent and facilities.",
    module: "listing-growth",
    name: "Public Page for Hostel",
    plan: "go",
    slug: "public-listing",
  },
  {
    audience: ["Hostel admin"],
    blurb: "A pin on the map, with directions that open in the visitor's phone.",
    module: "listing-growth",
    name: "Map Listing",
    plan: "go",
    slug: "map-presence",
  },
  {
    audience: ["Resident", "Hostel admin"],
    blurb: "Ratings from people who actually lived there.",
    module: "listing-growth",
    name: "Reviews",
    plan: "go",
    slug: "reviews",
  },
  {
    audience: ["Hostel admin"],
    blurb:
      "Mattresses, buckets, cleaning supplies — ordered in the portal, paid on delivery.",
    module: "listing-growth",
    name: "Supply Store",
    plan: "go",
    slug: "supply-store",
  },
  {
    audience: ["Hostel admin"],
    blurb:
      "Your public page laid out the way you want it, with your name and colours carried through the portal, the app and every receipt.",
    module: "listing-growth",
    name: "Customizable Public Page & Branding",
    plan: "max",
    slug: "public-page-branding",
  },
  // Reporting & Control
  {
    audience: ["Hostel admin", "Warden"],
    blurb: "Occupancy, dues, open complaints and tonight's night status, on one screen.",
    module: "reporting",
    name: "Daily Dashboard",
    plan: "go",
    slug: "operations-dashboard",
  },
  {
    audience: ["Hostel admin"],
    blurb: "Trends across months — occupancy, collection rate, complaint load.",
    module: "reporting",
    name: "Monthly Trends",
    plan: "pro",
    slug: "operations-analytics",
  },
  {
    audience: ["Hostel admin"],
    blurb: "Who changed what, when, and from where.",
    module: "reporting",
    name: "Audit Trail",
    plan: "max",
    slug: "audit-log",
  },
  {
    audience: ["Hostel admin"],
    blurb:
      "Every property side by side, staff and rooms scoped to their own building, and one bill at the end of it.",
    module: "reporting",
    name: "Multi-Property Control",
    plan: "max",
    slug: "multi-property-control",
  },
  {
    audience: ["Hostel admin"],
    blurb:
      "Beds coming free and rent expected in the months ahead, read from notices, checkouts and the rate card.",
    module: "reporting",
    name: "Occupancy & Revenue Forecast",
    plan: "max",
    slug: "occupancy-forecast",
  },
  {
    audience: ["Hostel admin"],
    blurb:
      "Residents, invoices and payments readable by whatever you already run, and a webhook the moment they change.",
    module: "reporting",
    name: "API Access & Webhooks",
    plan: "max",
    slug: "api-access",
  },
  {
    audience: ["Hostel admin"],
    blurb:
      "Your data migrated for you, a named manager, and a support queue that answers you first.",
    module: "reporting",
    name: "Priority Support & Migration",
    plan: "max",
    slug: "priority-support",
  },
];

export const DEFAULT_PLANS: PlansConfig = {
  cycleLabels: { annual: "Annual", halfYearly: "6 months", monthly: "Monthly" },
  // Standard out of the box. An event is switched on in Platform → Website
  // Config → Plans & Pricing when there is one to run.
  event: { endsOn: "", label: "Festival offer", mode: "standard", note: "" },
  modules: PLAN_MODULES,
  page: {
    ctaBody:
      "Tell us how many beds you run across how many buildings and we will price it as one account — including when the answer is three separate Go plans.",
    ctaHref: "/contact",
    ctaLabel: "Talk to {siteName}",
    ctaTitle: "Running more than one property?",
    featuredBadge: "Most chosen",
    footnote:
      "Prices are per hostel and exclude applicable taxes. Move between plans as your resident count changes — {siteName} keeps your data either way.",
    subtitle:
      "Priced by how many residents you house. Open any service to see what it does before you pay for it.",
    title: "Plans & Pricing",
  },
  plans: PLAN_TIERS,
  services: PLAN_SERVICES.map((service) => {
    const explainer = DEFAULT_SERVICE_EXPLAINERS[service.slug];

    return {
      ...service,
      // No clip has been recorded for anything yet; the detail page shows its
      // "a walkthrough goes here" frame until the owner uploads one.
      demo: { mobileAssetId: "", webAssetId: "" },
      how: explainer?.how ?? [],
      what: explainer?.what ?? [],
      why: explainer?.why ?? [],
    };
  }),
};
