import { REALTIME_TOPIC } from "@/constants/topics";
import type { AdminModeration, AdminModerationFilter } from "@/lib/admin-api";
import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import { defineQuery } from "@/lib/query-cache";
import type { StoreOrder, StoreOrderStatus } from "@/lib/store-api";

/**
 * The superadmin's day-to-day work in the app — hostels, people and money —
 * on exactly the routes the web's platform pages call (`platform-endpoints.ts`,
 * `platform-hostels-page.tsx`, `platform-subscription-claims.tsx`,
 * `platform-store-orders-page.tsx`). The server's System area is
 * `platform-api.ts`.
 */

const get = async <T>(path: string) => unwrap(await api.get<ApiEnvelope<T>>(path));
const send = async <T>(method: "delete" | "patch" | "post" | "put", path: string, body?: unknown) =>
  unwrap(await api[method]<ApiEnvelope<T>>(path, body as never));

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

export type PlatformDashboard = {
  activeResidents: number;
  complaints: number;
  inquiries: number;
  openListingFlags: number;
  outstandingPayments: number;
  pendingApprovals: number;
  platformPayments: number;
  reviews: number;
  serviceProviders: number;
  totalHostels: number;
  windowDays: number;
};

export const getPlatformDashboard = () => get<PlatformDashboard>("/platform/reports/dashboard");

/* -------------------------------------------------------------------------- */
/* Hostels                                                                    */
/* -------------------------------------------------------------------------- */

export type PlatformHostel = {
  applicationStatus?: string;
  archiveReason?: string;
  branchOf?: { id: string; name: string } | null;
  capacitySummary?: { totalBeds?: number; totalRooms?: number; vacantBeds?: number };
  contact?: { email?: string; phone?: string };
  createdAt?: string;
  hostelCode?: string;
  hostelType: string;
  id: string;
  isArchived?: boolean;
  isDemoData?: boolean;
  kyc?: { note: string | null; status: string; submittedAt: string | null } | null;
  location: { address?: string; area: string; city?: string; province?: string };
  name: string;
  owner?: { email: string; name: string; phone: string } | null;
  panNumber?: string | null;
  photos: { url?: string }[];
  portals?: { accounts: number; lastOpenedAt: string | null; opened: number; role: string }[];
  pricing?: { monthlyRentMax?: number; monthlyRentMin?: number };
  purgeScheduledAt?: string | null;
  slug: string;
  status: string;
  submittedAt?: string | null;
  suspension?: { graceEndsAt: string; reason: string; stage: "PRE_SUSPENSION" | "SUSPENDED"; startedAt: string } | null;
  verificationStatus: string;
};

type Contact = { email: string; id: string; name: string; phone: string; registeredAt: string | null; role: string } | null;

export type PlatformHostelDetail = {
  applicant: Contact;
  application: {
    id: string;
    infoRequestNote: string;
    rejectionReason: string;
    requestedDocuments: { documentType: string; note: string }[];
    status: string;
    submittedAt: string | null;
  } | null;
  documents: {
    createdAt: string | null;
    documentType: string;
    fileAssetId: string | null;
    fileUrl: string;
    id: string;
    rejectionReason: string;
    status: string;
  }[];
  hostel: PlatformHostel;
  owner: Contact;
  submitter: Contact;
};

export type PlatformHostelBilling = {
  plan: { amountDue: number; amountPaid: number; cycleLabel: string | null; planName?: string; status?: string } | null;
};

type HostelPage = { hostels: PlatformHostel[]; pagination: { total: number } };

/** The live queue and the archived one are separate reads (web `hostelsArchived`). */
export const listPlatformHostels = async (archived = false) =>
  (await get<HostelPage>(`/platform/hostels?pageSize=100${archived ? "&archived=only" : ""}`)).hostels;

export const getPlatformHostel = (id: string) => get<PlatformHostelDetail>(`/platform/hostels/${id}`);
export const getPlatformHostelBilling = (id: string) => get<PlatformHostelBilling>(`/platform/hostels/${id}/billing`);

export type HostelAction = "approve" | "archive" | "publish" | "reject" | "request-documents" | "restore" | "unpublish";

/** Web `actionsForHostel`: only the moves valid from the hostel's current status. */
export function hostelActions(hostel: PlatformHostel): HostelAction[] {
  if (hostel.isArchived) return ["restore"];
  const review: HostelAction[] =
    hostel.status === "DRAFT" || hostel.status === "PENDING_APPROVAL"
      ? ["approve", "request-documents", "reject"]
      : hostel.status === "APPROVED"
        ? ["publish", "reject"]
        : hostel.status === "PUBLISHED"
          ? ["unpublish"]
          : hostel.status === "REJECTED"
            ? ["approve", "request-documents"]
            : [];
  return [...review, "archive"];
}

/** Every action is a PATCH on its own door; reject/unpublish/archive need a reason. */
export const runHostelAction = (id: string, action: HostelAction, body: Record<string, unknown> = {}) =>
  send<unknown>("patch", `/platform/hostels/${id}/${action}`, body);

export const suspendHostel = (id: string) => send<unknown>("patch", `/platform/hostels/${id}/suspend`, { reason: "PLAN_PAYMENT" });
export const liftHostelSuspension = (id: string) => send<unknown>("delete", `/platform/hostels/${id}/suspend`);

export const isAwaitingReview = (hostel: PlatformHostel) =>
  hostel.status === "PENDING_APPROVAL" ||
  hostel.status === "DRAFT" ||
  hostel.verificationStatus === "PENDING" ||
  hostel.verificationStatus === "UNDER_REVIEW" ||
  hostel.kyc?.status === "SUBMITTED";

export const hostelStatusTone = (status: string) =>
  (({ APPROVED: "info", DRAFT: "neutral", PENDING_APPROVAL: "warning", PUBLISHED: "success", REJECTED: "danger", SUSPENDED: "danger" }) as const)[
    status as "DRAFT"
  ] ?? "neutral";

export const statusLabel = (status: string) => status.replace(/_/g, " ").toLowerCase().replace(/^\w/, (c) => c.toUpperCase());

/* -------------------------------------------------------------------------- */
/* People                                                                     */
/* -------------------------------------------------------------------------- */

export type PlatformPerson = {
  activationStatus: string;
  createdAt: string | null;
  email: string;
  emergencyContact: { name: string; phone: string; relation: string } | null;
  feeMonth: string;
  feeStatus: string;
  guardian: { name: string; phone: string; relation: string } | null;
  hostelCount: number;
  hostelName: string;
  id: string;
  isDemoData: boolean;
  lastLoginAt: string | null;
  moveInDate: string | null;
  name: string;
  nightStatus: string;
  phone: string;
  residentStatus: string;
  role: string;
  stayType: string;
  status: string;
};

export type PlatformDirectory = { people: PlatformPerson[]; roleCounts: Record<string, number>; total: number };

export const getPlatformDirectory = () => get<PlatformDirectory>("/platform/users");

/** Superadmin only. Blocking signs them out everywhere and refuses every sign-in. */
export const setUserBlocked = (id: string, blocked: boolean) =>
  send<{ user: { id: string; status: string } }>(blocked ? "patch" : "delete", `/platform/users/${id}/block`);

/* -------------------------------------------------------------------------- */
/* Plan billing                                                               */
/* -------------------------------------------------------------------------- */

export type PlanInvoiceRow = {
  amount: number;
  cycle: string;
  dueAt: string | null;
  hostelId: string;
  hostelName: string;
  invoiceNumber: string;
  issuedAt: string | null;
  outstanding: number;
  paid: number;
  planName: string;
  printedNumber: string;
  status: string;
};

export type PlanPaymentRow = {
  amount: number;
  hostelId: string;
  hostelName: string;
  invoiceNumber: string;
  method: string;
  paidAt: string | null;
  provider: string | null;
  receiptNumber: string | null;
  status: string;
};

export type PlanLedger = {
  invoices: PlanInvoiceRow[];
  payments: PlanPaymentRow[];
  totals: { activePlans: number; billed: number; collected: number; outstanding: number };
};

export const getPlanLedger = () => get<PlanLedger>("/platform/subscriptions");

export type PlanClaim = {
  amount: number;
  claimedAt: string | null;
  hostelId: string;
  hostelName: string;
  id: string;
  invoiceNumber: string;
  note: string | null;
  planName: string;
  proofAssetId: string | null;
  reference: string | null;
};

export const listPlanClaims = async () => (await get<{ claims: PlanClaim[] }>("/platform/subscriptions/claims")).claims;

/** Confirming records the payment, issues the receipt and clears the due. */
export const reviewPlanClaim = (id: string, approve: boolean, note?: string) =>
  send<unknown>("post", `/platform/subscriptions/claims/${id}/review`, { approve, note: note?.trim() || undefined });

export type FieldCash = {
  amount: number;
  collectedAt: string;
  collectedBy: string;
  hostelName: string;
  id: string;
  invoiceNumber: string;
  planName: string;
  reference: string | null;
  transactionNo: string | null;
};

export const listFieldCash = async () => (await get<{ cash: FieldCash[] }>("/platform/subscriptions/cash")).cash;

export const checkFieldCash = (id: string) => send<{ result: unknown }>("post", `/platform/subscriptions/cash/${id}/check`, {});

/* -------------------------------------------------------------------------- */
/* Supply store orders                                                        */
/* -------------------------------------------------------------------------- */

export type PlatformStoreOrder = StoreOrder & { hostelName: string };
export type PlatformStoreOrders = {
  orders: PlatformStoreOrder[];
  summary: { deliveredRevenue: number; open: number; total: number };
};

export const listPlatformStoreOrders = (status: "all" | "open") =>
  get<PlatformStoreOrders>(`/platform/store/orders?status=${status}&pageSize=100`);

/** `storeOrderStatusSchema`: the moves a platform admin makes on an order. */
export const NEXT_ORDER_STATUS: Partial<Record<StoreOrderStatus, StoreOrderStatus>> = {
  CONFIRMED: "PACKED",
  PACKED: "SHIPPED",
  PLACED: "CONFIRMED",
  SHIPPED: "DELIVERED",
};

export const setStoreOrderStatus = (id: string, status: StoreOrderStatus, note?: string) =>
  send<unknown>("patch", `/platform/store/orders/${id}/status`, { note: note?.trim() || undefined, status });

/* -------------------------------------------------------------------------- */
/* Moderation                                                                 */
/* -------------------------------------------------------------------------- */

/** Every space's reported posts — the same shape as the hostel admin's queue. */
export const platformModerationQuery = (filter: AdminModerationFilter) =>
  defineQuery(`platform:moderation:${filter}`, [REALTIME_TOPIC.COMMUNITY], () =>
    get<AdminModeration>(`/platform/community?filter=${filter}&pageSize=100`),
  );

export const hidePlatformPost = async (postId: string, reason: string) => {
  await api.patch(`/platform/community/${postId}/hide`, { reason });
};

export const clearPlatformPost = async (postId: string, reason: string) => {
  await api.delete(`/platform/community/${postId}/hide`, { data: { reason } });
};

export type ListingFlag = {
  createdAt?: string;
  hostelId: string;
  id: string;
  matchedHostelIds: string[];
  reason: string;
  resolutionNote: string;
  resolvedAt?: string;
  riskLevel: "HIGH" | "LOW" | "MEDIUM";
  signals: string[];
  status: "DISMISSED" | "OPEN" | "RESOLVED";
};

export const listListingFlags = async (status: "OPEN" | "RESOLVED" | "DISMISSED") =>
  (await get<{ flags: ListingFlag[] }>(`/platform/listing-flags?status=${status}&pageSize=100`)).flags;

export const resolveListingFlag = (id: string, status: "DISMISSED" | "RESOLVED", resolutionNote: string) =>
  send<unknown>("patch", `/platform/listing-flags/${id}/resolve`, { resolutionNote: resolutionNote.trim(), status });

/* -------------------------------------------------------------------------- */
/* Push                                                                       */
/* -------------------------------------------------------------------------- */

export const PUSH_AUDIENCES = ["EVERYONE", "HOSTEL_STAFF", "RESIDENTS", "GUARDIANS"] as const;
export type PushAudience = (typeof PUSH_AUDIENCES)[number];

export type PushSent = {
  audience: string;
  body: string;
  devices: number;
  id: string;
  recipients: number;
  scheduled: boolean;
  sentAt: string;
  title: string;
  urgency: string;
};

export type PushSchedule = {
  audience: string;
  automatic: string | null;
  body: string;
  id: string;
  lastRunAt: string | null;
  nextRunAt: string | null;
  repeat: string;
  runCount: number;
  status: string;
  time: string;
  title: string;
  weekdays: number[];
};

export type PlatformPushes = { automatic: PushSchedule[]; pushes: PushSent[]; schedules: PushSchedule[] };

export const listPlatformPushes = () => get<PlatformPushes>("/platform/push");

/** `platformPushSchema`: NOW sends in this request; ONCE/DAILY/WEEKLY go to the cron. */
export const sendPlatformPush = (input: {
  audience: PushAudience;
  body: string;
  date?: string;
  repeat: "DAILY" | "NOW" | "ONCE" | "WEEKLY";
  time?: string;
  title: string;
  urgency: "NORMAL" | "URGENT";
  weekdays?: number[];
}) => send<unknown>("post", "/platform/push", input);

export const updatePushSchedule = (id: string, action: "CANCEL" | "PAUSE" | "RESUME") =>
  send<unknown>("patch", `/platform/push/schedules/${id}`, { action });

/* -------------------------------------------------------------------------- */
/* Website config: feature flags + the site-wide announcement bar             */
/* -------------------------------------------------------------------------- */

export type FeatureFlags = { compare: boolean; inquiries: boolean; publicRegistration: boolean; reviews: boolean; serviceProviderSignup: boolean };
export type Announcement = { enabled: boolean; link: string; linkLabel: string; message: string; tone: "info" | "success" | "warning" };

export const getSiteFlags = async () => {
  const { config } = await get<{ config: { announcement?: Announcement; features?: FeatureFlags } }>("/platform/site-config");
  return { announcement: config.announcement, features: config.features };
};

/** A section is replaced whole (`siteConfigSectionSchemas[section]`). */
export const saveSiteSection = (section: "announcement" | "features", value: Announcement | FeatureFlags) =>
  send<unknown>("put", `/platform/site-config/${section}`, value);
