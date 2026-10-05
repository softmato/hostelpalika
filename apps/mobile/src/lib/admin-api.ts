/**
 * Hostel admin, deliberately reduced.
 *
 * This is **not** a port of the web portal. The web has 80-odd `hostel-admin/*`
 * routes covering fee schedules, billing runs, statement reconciliation, warden
 * management, room configuration and a dozen report views — none of which
 * anyone does on a phone between two other things. What is left here is the
 * short list an admin actually reaches for while away from their desk:
 *
 *  - what the hostel looks like right now (occupancy, dues, today's activity),
 *  - the four things that arrive unprompted and need a person: an inquiry, a
 *    payment claim, a complaint, an SOS,
 *  - the one decision each of those wants, and nothing else.
 *
 * Everything beyond that opens the web portal in a browser. That is a design
 * decision, not a gap — see `WEB_PORTAL_PATHS` at the bottom.
 *
 * ## Capabilities, and why a 403 here is not a bug
 *
 * A WARDEN's routes run through `requireHostelCapability`, which narrows the
 * principal's hostels to those where the flag is granted and 403s with
 * `CAPABILITY_DENIED` when none are. A HOSTEL_ADMIN holds every capability
 * implicitly. So each read below can legitimately fail for a warden while its
 * neighbour succeeds, and the alert inbox therefore loads its four sources
 * **independently and tolerantly** — one denied source must not blank the
 * other three. `settledList` is that rule.
 *
 * Shapes mirror the serializers in `apps/web/src/modules/*`, read from the
 * services rather than guessed from route names.
 */

import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import type { ResidentAccount } from "@/lib/admin-manage-api";
import type { CommunityMedia } from "@/lib/community-api";
import type { ExpenseRow } from "@/lib/expenses";
import type { FoodRoutine } from "@/lib/resident-api";

/* -------------------------------------------------------------------------- */
/* Dashboard                                                                  */
/* -------------------------------------------------------------------------- */

/** `getHostelAdminDashboardReport`'s `report`. */
export type AdminReport = {
  complaints: number;
  foodFeedback: number;
  maintenanceRequests: number;
  /** This month's billed total — not "everything ever issued". */
  monthlyDues: number;
  nightStatusSummary: Record<string, number>;
  paidAmount: number;
  pendingPaymentProofs: number;
  publicViewsLast30Days: number;
  residents: number;
  totalPublicViews: number;
  uniquePublicVisitors: number;
  vacantBeds: number;
};

export async function getAdminReport() {
  const response = await api.get<ApiEnvelope<{ report: AdminReport }>>(
    "/hostel-admin/reports/dashboard",
  );

  return unwrap(response).report;
}

/** The subset of `serializeHostel` this app reads. */
export type AdminHostel = {
  capacitySummary: {
    totalBeds?: number;
    totalRooms?: number;
    vacantBeds?: number;
  };
  contact: { email?: string; phone?: string };
  /** `BOYS` / `GIRLS` / `CO_LIVING` — the tag the public listing leads with. */
  hostelType: string;
  id: string;
  location: { address?: string; area?: string; city?: string };
  name: string;
  /**
   * The gallery, so Home can lead with the building.
   *
   * Stored **relative** (`/api/v1/files/<id>/url`) and therefore unloadable as
   * given — run it through `absoluteMediaUrl` before it reaches an `<Image>`.
   * The server does not sort this array on the admin serializer the way it does
   * on the public one, so the cover is picked client-side by `kind`.
   */
  photos: {
    alt: string;
    id?: string;
    kind: string;
    roomType: string;
    url: string;
  }[];
  /** The tenant segment in `/{slug}/admin` — needed to open the web portal. */
  slug: string;
  status: string;
  verificationStatus: string;
};

/**
 * What this hostel owes the platform for its plan, if anything.
 *
 * Only a hostel our field team registered can owe anything: an agent publishes
 * the listing on the strength of having met the owner, and whatever they did not
 * collect that day becomes a due. A hostel that registered itself paid before it
 * was published, so this comes back `null` for almost every reader — which is
 * exactly why the banner that uses it renders nothing at all rather than an
 * empty state.
 */
export type AdminSubscription = {
  invoice: { id: string; invoiceNumber: string } | null;
  outstanding: number;
  /**
   * Every payment ever attempted against this plan, newest first — the shape
   * `getSubscriptionState` has always returned and this type used to drop.
   *
   * The due card reads exactly one thing off it: whether a row is `IN_REVIEW`,
   * meaning the owner has already sent us proof and is waiting on a person. The
   * balance does not move while that is true — only `SETTLED` rows count — so
   * without this the card would still be calling the balance due to somebody
   * who paid an hour ago, which is how a hostel pays us twice.
   */
  payments: {
    amount: number;
    id: string;
    method: string;
    settledAt: string | null;
    status: string;
  }[];
  subscription: {
    id: string;
    dueBy: string | null;
    /** The free month running today — null outside the free months. */
    freeMonthNow?: {
      endsAt: string;
      left: number;
      month: number;
      of: number;
    } | null;
    freeUntil?: string | null;
    /** Stable catalogue key; the branch switcher is reserved for the Max plan. */
    planId: string | null;
    planName: string | null;
    status: string;
  };
};

/** Is a manual payment claim sitting with the platform right now? */
export function hasClaimInReview(state: AdminSubscription | null) {
  return Boolean(
    state?.payments?.some((payment) => payment.status === "IN_REVIEW"),
  );
}

/** One hostel the owner runs, as the dashboard's branches card and the switcher show it. */
export type AdminBranchRow = {
  area?: string;
  city?: string;
  beds: number;
  collected: number;
  /** First exterior photo, relative or absolute — resolve with `absoluteMediaUrl`. */
  coverUrl?: string | null;
  due: number;
  id: string;
  isBranch: boolean;
  name: string;
  occupancyPercent: number | null;
  openComplaints: number;
  residents: number;
  slug: string;
  status: string;
};

/** The main hostel's branches and how many more its plan allows (`GET /hostel-admin/branches`). */
export type AdminBranches = {
  allowance: {
    active: boolean;
    cap: number;
    planName: string | null;
    used: number;
  };
  branches: {
    area: string;
    city: string;
    id: string;
    name: string;
    slug: string;
    status: string;
  }[];
  main: {
    id: string;
    name: string;
    slug: string;
    status: string;
    area: string;
    city: string;
    panNumber: string | null;
  };
};

export async function getBranches() {
  const response = await api.get<ApiEnvelope<AdminBranches>>(
    "/hostel-admin/branches",
  );

  return unwrap(response);
}

/** Files a branch; a superadmin calls it before it goes live. The body is `branchRequestSchema`. */
export async function requestBranch(body: Record<string, unknown>) {
  const response = await api.post<
    ApiEnvelope<{ branch: { id: string; name: string; status: string } }>
  >("/hostel-admin/branches", body);

  return unwrap(response);
}

/** Every hostel the owner runs — empty for an owner with one, so nothing renders. */
export async function getBranchesSummary() {
  const response = await api.get<
    ApiEnvelope<{ hostels: AdminBranchRow[]; period: string }>
  >("/hostel-admin/branches/summary");

  return unwrap(response);
}

export async function getAdminSubscription() {
  const response = await api.get<
    ApiEnvelope<{ state: AdminSubscription | null }>
  >("/hostel-admin/subscription");

  return unwrap(response).state;
}

/*
 * No plan payment calls here. `hostel-admin/billing/pay-instructions` and
 * `/claim` served the *Pay your plan* screen, removed on 2026-09-15 because the
 * app may not take payment for the plan. See `components/subscription-due.tsx`.
 */

export async function getAdminHostel() {
  const response = await api.get<ApiEnvelope<{ hostel: AdminHostel }>>(
    "/hostel-admin/profile",
  );

  return unwrap(response).hostel;
}

/**
 * One month's money, rolled up — `PeriodRow` in `finance/period-summary.service`.
 *
 * `collected` and `due` are **amounts**; `paid`, `total` and `needsAttention`
 * are invoice counts. Mixing the two is the mistake this comment exists to
 * prevent: `paid` next to a currency symbol reads as a plausible figure that is
 * out by three orders of magnitude.
 */
export type AdminPeriodRow = {
  collected: number;
  due: number;
  needsAttention: number;
  paid: number;
  /** `2026-08`. */
  period: string;
  total: number;
};

/** `getPeriodSummary`'s payload — every month, plus lifetime figures. */
export type AdminPeriodSummary = {
  earliestPeriod: string;
  /** Newest first, and gap-filled: a month with no invoices is present at zero. */
  months: AdminPeriodRow[];
  overall: {
    collected: number;
    due: number;
    outstanding: number;
    overdueResidents: number;
    paid: number;
    partial: number;
    pendingProofs: number;
    unpaid: number;
  };
};

/**
 * `GET /hostel-admin/finance/invoices/periods` — what the hostel has earned.
 *
 * The dashboard report answers "this month" and nothing else, which is the one
 * question a hostel owner does *not* need an app to answer — they know what
 * this month looks like. What they cannot get anywhere else on a phone is the
 * shape of it: earned since opening, and the last few months side by side.
 * This route already computed both for the portal's month picker, in one pass
 * over the same invoices, so Home reads it rather than fetching six months of
 * the invoice matrix and adding them up on the device.
 *
 * Behind `viewPayments`, so a warden without the grant gets a 403 — call it
 * tolerantly and let the screen fall back to the report's monthly figures.
 */
export async function getAdminPeriodSummary() {
  const response = await api.get<ApiEnvelope<AdminPeriodSummary>>(
    "/hostel-admin/finance/invoices/periods",
  );

  return unwrap(response);
}

/* -------------------------------------------------------------------------- */
/* Alerts                                                                     */
/* -------------------------------------------------------------------------- */

export type AdminInquiry = {
  createdAt?: string;
  email: string;
  id: string;
  message: string;
  name: string;
  phone: string;
  preferredRoomType: string;
  source: string;
  status: string;
};

/**
 * The six things the server checks before a claim is worth believing —
 * `ClaimCheck` in `finance/review.service`.
 *
 * **`detail` is the field to render, and it is a whole sentence.** This type
 * previously said `{ label, ok }`, which is not what crosses the wire: nothing
 * read it, so a screen printing `check.label` would have rendered `undefined`
 * under every claim. Screens pair `detail` with their own short word for the
 * `key` rather than rephrasing it — the server wrote "Claimed 12000 against
 * 5000 outstanding" carefully, and money evidence is the wrong place to
 * paraphrase.
 */
export type AdminClaimCheck = {
  detail: string;
  key:
    | "AMOUNT"
    | "EVIDENCE"
    | "FILE"
    | "INVOICE_OPEN"
    | "PAYEE"
    | "REFERENCE"
    | "SIMILARITY";
  ok: boolean;
};

export type AdminClaim = {
  /** Every server-side check, green or not — the same rule `Approve all` uses. */
  allGreen: boolean;
  amount: number;
  checks: AdminClaimCheck[];
  confirmation: string;
  eventId: string;
  evidenceAssetId: string | null;
  evidenceMimeType: string | null;
  invoiceId: string | null;
  method: string;
  occurredAt: string;
  period: string | null;
  referenceNote: string | null;
  rejectionReason: string | null;
  residentId: string;
  residentName: string;
  status: string;
  transactionCode: string | null;
};

export type AdminComplaint = {
  adminResponse: string;
  category: string;
  createdAt?: string;
  description: string;
  id: string;
  isAnonymous: boolean;
  /** Past its SLA and still open. The reason a row is worth surfacing. */
  isOverdue: boolean;
  /** Null when the complaint is anonymous — the server withholds it. */
  residentId: string | null;
  slaDueAt: string;
  status: string;
  title: string;
};

export type AdminSosAlert = {
  acknowledgedAt?: string;
  createdAt?: string;
  guardianAlertEnabled: boolean;
  id: string;
  message: string;
  residentId: string;
  resolvedAt?: string;
  status: "ACKNOWLEDGED" | "ACTIVE" | "FALSE_ALARM" | "RESOLVED";
};

export type AdminResident = {
  /** Null until they activate a login. See {@link ResidentAccount}. */
  account?: ResidentAccount | null;
  email: string;
  firstName: string;
  id: string;
  lastName: string;
  monthlyFee: number;
  moveInDate: string;
  phone: string;
  residentType: string;
  roomType: string;
  status: string;
};

async function listInquiries() {
  const response = await api.get<ApiEnvelope<{ inquiries: AdminInquiry[] }>>(
    "/hostel-admin/inquiries",
    { params: { pageSize: 20, status: "NEW" } },
  );

  return unwrap(response).inquiries;
}

async function listClaims() {
  const response = await api.get<ApiEnvelope<{ events: AdminClaim[] }>>(
    "/hostel-admin/finance/events",
    { params: { status: "PENDING" } },
  );

  return unwrap(response).events;
}

async function listComplaints() {
  const response = await api.get<ApiEnvelope<{ complaints: AdminComplaint[] }>>(
    "/hostel-admin/complaints",
    { params: { pageSize: 20, sla: "overdue" } },
  );

  return unwrap(response).complaints;
}

async function listSosAlerts() {
  const response = await api.get<ApiEnvelope<{ alerts: AdminSosAlert[] }>>(
    "/hostel-admin/sos-alerts",
    { params: { pageSize: 20, status: "ACTIVE" } },
  );

  return unwrap(response).alerts;
}

export async function listAdminResidents(query: { q?: string } = {}) {
  const response = await api.get<ApiEnvelope<{ residents: AdminResident[] }>>(
    "/hostel-admin/residents",
    { params: { pageSize: 50, ...(query.q ? { q: query.q } : {}) } },
  );

  return unwrap(response).residents;
}

export type AdminAlerts = {
  claims: AdminClaim[];
  complaints: AdminComplaint[];
  /** Which sources the caller's capabilities refused. Rendered, not swallowed. */
  denied: string[];
  inquiries: AdminInquiry[];
  sos: AdminSosAlert[];
};

/**
 * Runs one source and reports a refusal instead of failing the batch.
 *
 * A warden granted `viewComplaints` but not `viewPayments` gets a 403 from the
 * claims queue and a 200 from everything else. `Promise.all` would turn that
 * into an empty error screen; a bare `.catch(() => [])` would turn it into
 * "no payment claims", which is worse — it is the guardian mistake again, an
 * empty list standing in for a denial. So the source's name is collected and
 * the inbox says which parts it could not read.
 */
async function settledList<T>(
  name: string,
  load: () => Promise<T[]>,
  denied: string[],
): Promise<T[]> {
  try {
    return await load();
  } catch {
    denied.push(name);
    return [];
  }
}

/** The four things that arrive unprompted, in one pull. */
export async function getAdminAlerts(): Promise<AdminAlerts> {
  const denied: string[] = [];

  const [sos, claims, complaints, inquiries] = await Promise.all([
    settledList("SOS alerts", listSosAlerts, denied),
    settledList("payment claims", listClaims, denied),
    settledList("complaints", listComplaints, denied),
    settledList("inquiries", listInquiries, denied),
  ]);

  return { claims, complaints, denied, inquiries, sos };
}

/* -------------------------------------------------------------------------- */
/* Money                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One resident's month, billed or not — `getInvoiceMatrix`'s row.
 *
 * `displayStatus` is the field to render, not `payment.status`: a resident with
 * no invoice for the period has no payment at all, and the server says
 * `NOT_BILLED` rather than leaving a gap for the client to interpret. Reading
 * `payment?.status ?? "PAID"` — the obvious mistake — would report an unbilled
 * resident as settled.
 */
export type AdminInvoiceRow = {
  displayStatus: string;
  /**
   * What this month **would** cost, and why no invoice exists — set only on a
   * `NOT_BILLED` row.
   *
   * A projection, never a debt: `amountOwed` deliberately ignores it, because a
   * hostel's outstanding total must not count money nobody has been invoiced
   * for. It is here so the screen can answer the two questions "Not billed" left
   * hanging — how much, and does anybody have to do something.
   *
   * Optional on the type because a phone can be pointed at an API older than
   * this build (`EXPO_PUBLIC_API_URL` sends even a debug build to the deployed
   * origin). An absent field renders as the bare status it always did.
   */
  notBilled?: {
    /** Null when nothing prices this resident — see `reason`. */
    amount: number | null;
    /**
     * `NOT_YET_RUN` — priceable, the month's run has not happened.
     * `FEE_SCHEDULE_MISSING` / `BED_TYPE_NOT_PRICED` — no rate card and no
     * listed rent covers this room type; a person has to fix it.
     * `NOT_YET_RESIDENT` / `ALREADY_MOVED_OUT` / `NO_BILLABLE_DAYS` /
     * `ZERO_CHARGE` — nothing is owed, and that is correct.
     */
    reason: string;
  } | null;
  payment: {
    /** What the month costs. `paidAmount` is what has actually landed. */
    dueAmount: number;
    /** ISO — `PortalInvoice` types it as a `Date`, but this crossed JSON. */
    dueDate?: string;
    id: string;
    /** The bill's lines — a `FINE` or `KHATA` one explains a bigger total. */
    lines?: { amount: number; basis: string; description: string }[];
    method?: string;
    /** `2026-08`. Renamed from `period` by the portal's own serializer. */
    month: string;
    paidAmount: number;
    paidDate?: string;
    status: string;
  } | null;
  resident: {
    fullName: string;
    id: string;
    /** Their profile picture. Pass it through `useAvatarSource()`, never raw. */
    image?: string | null;
    moveInDate: string;
    phone?: string;
    roomNumber?: string | null;
    roomType?: string | null;
  };
};

export type AdminInvoiceMatrix = {
  month: string;
  rows: AdminInvoiceRow[];
  totals: {
    /** Money. */
    collected: number;
    /** Money — everything billed for the period, settled or not. */
    due: number;
    /** The rest are row counts, not amounts. */
    notBilled: number;
    overdue: number;
    paid: number;
    partial: number;
    unpaid: number;
  };
};

/**
 * `GET /hostel-admin/finance/invoices` — one row per resident for a period.
 *
 * **Reads never bill.** Its predecessor created an invoice for every unbilled
 * resident as a side effect of rendering, which is why opening a screen could
 * change what a resident owed; the current route is read-only and reports
 * `NOT_BILLED` instead. Worth knowing here because it means this is safe to
 * call on tab focus, which is exactly what the Money tab does.
 *
 * The period defaults server-side to the current month.
 */
export async function getAdminInvoices(period?: string) {
  const response = await api.get<ApiEnvelope<AdminInvoiceMatrix>>(
    "/hostel-admin/finance/invoices",
    { params: period ? { period } : {} },
  );

  return unwrap(response);
}

/**
 * One invoice on the hostel's lifetime ledger — `HostelLedgerEntry`.
 *
 * A superset of {@link AdminInvoiceRow}'s `payment`, and the fields it adds are
 * why the statement screen reads this route rather than the matrix:
 * `residentName` (the matrix carries a whole `resident` object; this one is
 * flattened), `paymentMethod`, `remarks` and `createdAt`.
 *
 * `month` is `null` for a one-off that belongs to no period — an admission fee
 * is the common one, and it appears in **no** month of the matrix at all. That
 * is the whole reason this route exists; see `getHostelLedger` on the server.
 *
 * `method` and `paymentMethod` are the same string twice: the serializer spreads
 * `toPortalInvoice` (which names it `method`) and then adds `paymentMethod`
 * beside it. Read either — this type says so rather than letting a caller
 * discover it.
 *
 * `paymentMethod` is a **provider word run through a lookup**, so it is
 * `undefined` — not `"OTHER"` — for a settlement whose provider is unmapped or
 * absent. `lib/hostel-statement.ts` is what normalises that.
 */
export type AdminLedgerEntry = {
  /** ISO. When the invoice was raised, not when it was paid. */
  createdAt?: string;
  dueAmount: number;
  dueDate?: string;
  id: string;
  method?: string;
  /** `2026-08`, or `null` for a one-off. */
  month: string | null;
  paidAmount: number;
  /** ISO. Absent on an invoice nothing has been paid against. */
  paidDate?: string;
  paymentMethod?: string;
  remarks?: string;
  residentId: string;
  /** Empty string when the resident record could not be resolved. */
  residentName: string;
  status: string;
};

export type AdminLedger = {
  entries: AdminLedgerEntry[];
  /**
   * The hostel's recorded expenses — the debit half of the statement. `null`
   * for anyone but the owner (a warden sees only their own spending, on the
   * expenses screen), and absent from a server that predates it.
   */
  expenses?: ExpenseRow[] | null;
  /**
   * The server capped the read at 5000 rows and dropped older ones. Anything
   * cumulative computed over these entries is therefore incomplete — see the
   * running total in `lib/hostel-statement.ts`, which refuses to guess.
   */
  truncated: boolean;
};

/**
 * `GET /hostel-admin/finance/invoices/ledger` — every invoice this hostel has
 * ever raised, newest first.
 *
 * Not `getAdminInvoices`. That one is the **month matrix**: one row per resident
 * for one period, which answers "who has not paid this month". This answers
 * "what has this hostel ever taken", which is a different question and the only
 * one a statement can be built from — a matrix has no row for an admission fee,
 * because an admission fee has no month.
 *
 * Needs `viewPayments`, so a warden without the grant gets a 403 carrying the
 * server's own wording. The statement screen renders that rather than swallowing
 * it into an empty list, which is the mistake `PermissionCard` exists to stop.
 *
 * **Reads never bill.** Same rule as the matrix, so this is safe on focus.
 */
export async function getAdminLedger() {
  const response = await api.get<ApiEnvelope<AdminLedger>>(
    "/hostel-admin/finance/invoices/ledger",
  );

  return unwrap(response);
}

/* -------------------------------------------------------------------------- */
/* Today                                                                      */
/* -------------------------------------------------------------------------- */

export type AdminNightStatusRow = {
  resident: {
    fullName: string;
    id: string;
    /** Their profile picture. Pass it through `useAvatarSource()`, never raw. */
    image?: string | null;
    roomType?: string;
    status: string;
  };
  status: {
    checkedAt: string | null;
    note: string;
    source: string;
    status: string;
  };
};

export type AdminNightStatus = {
  /**
   * Sent on every response and previously dropped on the floor.
   *
   * `manage/roll-call.tsx` is a *roster* screen — every resident, not a
   * digest — and without this it had no way to know whether it was looking at
   * the whole hostel or the first page of it. A screen that silently stops at
   * a hundred people is the failure mode this codebase keeps re-finding: the
   * server returned more than the hand-written type admitted.
   */
  pagination: {
    hasMore: boolean;
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
  statuses: AdminNightStatusRow[];
  summary: {
    INSIDE_HOSTEL: number;
    MARKED_SAFE: number;
    NOT_VERIFIED: number;
    OUTSIDE_HOSTEL: number;
    SOS_TRIGGERED: number;
    total: number;
  };
};

/**
 * `MAX_PAGE_SIZE` on the web side (`lib/pagination.ts`). Asking for more is a
 * 422 from Zod, not a larger page.
 */
export const NIGHT_STATUS_PAGE_SIZE = 100;

/**
 * `GET /hostel-admin/night-status` — tonight's roll call.
 *
 * The summary counts the **whole roster**, not the page: the service builds
 * every row, filters, and only then slices, because a resident with no status
 * row at all is `NOT_VERIFIED` rather than absent. So a small `pageSize` here
 * still yields a true total, which is what the tab shows.
 *
 * ## No `status` parameter, and there will not be one
 *
 * The endpoint takes `?status=`, and the summary above is computed over the
 * filtered roster — so asking it for `NOT_VERIFIED` returns a summary claiming
 * every resident is unverified, which is the number `AdminRollCallCard` draws
 * its progress bar from. Segmenting is `filterRollCall`'s job, client-side,
 * over an unfiltered fetch.
 */
export async function getAdminNightStatus({
  page = 1,
}: { page?: number } = {}) {
  const response = await api.get<ApiEnvelope<AdminNightStatus>>(
    "/hostel-admin/night-status",
    { params: { page, pageSize: NIGHT_STATUS_PAGE_SIZE } },
  );

  return unwrap(response);
}

export type AdminNotice = {
  category: string;
  content: string;
  createdAt?: string;
  expiresAt?: string;
  id: string;
  isUrgent: boolean;
  publishedAt?: string;
  targetAudience: string;
  title: string;
};

/** `GET /hostel-admin/notices` — newest first, urgent above the rest. */
export async function listAdminNotices() {
  const response = await api.get<ApiEnvelope<{ notices: AdminNotice[] }>>(
    "/hostel-admin/notices",
    { params: { pageSize: 10 } },
  );

  return unwrap(response).notices;
}

export type AdminMaintenanceRequest = {
  category: string;
  createdAt?: string;
  description: string;
  id: string;
  location: string;
  priority: string;
  scheduledFor?: string;
  status: string;
  title: string;
};

export type AdminMaintenance = {
  requests: AdminMaintenanceRequest[];
  /** Counted server-side: `open` is PENDING, CONTACTED or SCHEDULED. */
  summary: {
    cancelled: number;
    completed: number;
    open: number;
    total: number;
  };
};

/**
 * `GET /hostel-admin/maintenance/requests`.
 *
 * Unfiltered on purpose. The route's own `summary` counts what is open across
 * everything it returned, and asking for `?status=PENDING` would give a summary
 * that only ever said "all of them are pending" — the number the Today tab
 * needs is how many are open out of how many exist.
 */
export async function getAdminMaintenance() {
  const response = await api.get<ApiEnvelope<AdminMaintenance>>(
    "/hostel-admin/maintenance/requests",
  );

  return unwrap(response);
}

/**
 * `PATCH /hostel-admin/night-status/{residentId}/override`.
 *
 * The reason is **required** server-side (3–1000 chars) and that is the point:
 * this writes over what a resident said about themselves. A warden marking
 * somebody `INSIDE_HOSTEL` from the corridor is the most phone-shaped action in
 * the admin product, and it is also the one that most needs a record of who
 * decided and why — the service writes an audit entry from it.
 */
export async function overrideNightStatus(
  residentId: string,
  input: { reason: string; status: string },
) {
  await api.patch(`/hostel-admin/night-status/${residentId}/override`, input);
}

/**
 * `POST /hostel-admin/notices`.
 *
 * Title 2–160, content 2–4000, and the server defaults `category` to GENERAL,
 * `targetAudience` to ALL and `isUrgent` to false. Mobile sends title, content
 * and the urgent flag only: scheduling a notice for later, expiring it, or
 * aiming it at guardians alone are all decisions someone makes at a desk with
 * the calendar open, and each one is a field that would double the height of
 * a compose sheet used for "water is off until 4pm".
 */
export async function createAdminNotice(input: {
  content: string;
  isUrgent: boolean;
  title: string;
}) {
  await api.post("/hostel-admin/notices", input);
}

/**
 * `GET /hostel-admin/food/routine` — the same document the resident's Food tab
 * and the cook portal read, through the same serializer, so `FoodRoutine` is
 * shared rather than re-declared.
 */
export async function getAdminFoodRoutine() {
  const response = await api.get<ApiEnvelope<{ routine: FoodRoutine }>>(
    "/hostel-admin/food/routine",
  );

  return unwrap(response).routine;
}

/* -------------------------------------------------------------------------- */
/* The three decisions                                                        */
/* -------------------------------------------------------------------------- */

/**
 * `POST /hostel-admin/finance/events/{id}/approve`.
 *
 * Settling is pinned server-side to the claim still being `PENDING`, so a
 * double tap loses the race rather than crediting the invoice twice — the
 * client does not need its own lock, only a disabled button while in flight.
 */
export async function approveClaim(eventId: string) {
  await api.post(`/hostel-admin/finance/events/${eventId}/approve`, {});
}

/**
 * `POST /hostel-admin/finance/events/{id}/reject`.
 *
 * The reason is required (3–500 chars) **and shown to the resident**, which is
 * why the mobile sheet asks for it rather than sending a canned string: a
 * rejection a resident cannot act on sends them to the hostel office to ask why.
 */
export async function rejectClaim(eventId: string, rejectionReason: string) {
  await api.post(`/hostel-admin/finance/events/${eventId}/reject`, {
    rejectionReason,
  });
}

/**
 * `POST /hostel-admin/finance/events/{id}/ask-resident` — a templated "we
 * could not find this payment, send clearer details" message. Decides nothing.
 */
export async function askResidentAboutClaim(eventId: string) {
  await api.post(`/hostel-admin/finance/events/${eventId}/ask-resident`, {});
}

/**
 * `POST /hostel-admin/finance/events/bulk-approve` — explicit ids only. The
 * server re-checks each one and skips any that is no longer all-green.
 */
export async function bulkApproveClaims(eventIds: string[]) {
  const response = await api.post<
    ApiEnvelope<{ approved: string[]; skipped: { reason: string }[] }>
  >("/hostel-admin/finance/events/bulk-approve", { eventIds });

  return unwrap(response);
}

/**
 * Every complaint, not just the overdue ones — `GET /hostel-admin/complaints`.
 * One page at the route's ceiling; the complaints screen filters on the phone.
 */
export async function listAllComplaints() {
  const response = await api.get<ApiEnvelope<{ complaints: AdminComplaint[] }>>(
    "/hostel-admin/complaints",
    { params: { pageSize: 100 } },
  );

  return unwrap(response).complaints;
}

/** `PATCH /hostel-admin/complaints/{id}/status` — the reply, if any, goes with it. */
export async function setComplaintStatus(
  complaintId: string,
  status: "IN_PROGRESS" | "REJECTED" | "RESOLVED",
  response?: string,
) {
  await api.patch(`/hostel-admin/complaints/${complaintId}/status`, {
    response,
    status,
  });
}

/** `POST /hostel-admin/complaints/{id}/reply` — 2–2000 chars. */
export async function replyToComplaint(complaintId: string, message: string) {
  await api.post(`/hostel-admin/complaints/${complaintId}/reply`, { message });
}

/**
 * `PATCH /hostel-admin/sos-alerts/{id}/status`.
 *
 * Mobile offers `ACKNOWLEDGED` only. Resolving an alert and marking one a false
 * alarm are judgements about whether someone is safe; they belong to whoever
 * has actually checked, at a desk, with the roster in front of them. What a
 * phone is good for is the thing that has to happen in seconds — telling the
 * resident, and the rest of the staff, that a human has seen it.
 */
export async function acknowledgeSos(alertId: string) {
  await api.patch(`/hostel-admin/sos-alerts/${alertId}/status`, {
    status: "ACKNOWLEDGED",
  });
}

/* -------------------------------------------------------------------------- */
/* Community moderation                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A post as a moderator sees it — `listCommunityModeration`'s `posts`.
 *
 * The three moderator-only fields are `undefined` rather than absent from the
 * type because `serializePost` writes them conditionally on `isModeratorView`:
 * every other caller of that serializer omits them, and this route is the only
 * one in the mobile app that sets the flag.
 *
 * `reportCount` is the tally of open reports and is what the queue sorts on
 * after `flaggedAt`. `flaggedReason` is the triage model's sentence, not a
 * reporter's words — see `community-triage.ts`.
 */
export type AdminModeratedPost = {
  authorName: string;
  body: string;
  commentCount: number;
  createdAt?: string;
  flaggedAt?: string;
  flaggedReason?: string;
  hiddenReason?: string;
  hostelName: string | null;
  id: string;
  isAnnouncement: boolean;
  /**
   * Present on every post the serializer returns. The web panel's own type
   * drops it and its cards therefore never show the picture — which on a
   * *moderation* screen is the half of a reported post most likely to be the
   * reason it was reported.
   */
  media: CommunityMedia[];
  reactionCount: number;
  reportCount?: number;
  spaceType: "HOSTEL" | "PUBLIC";
  status: "HIDDEN" | "VISIBLE";
};

/** `flagged` is the queue; the other two browse what is in scope. */
export type AdminModerationFilter = "all" | "flagged" | "hidden";

export type AdminModeration = {
  posts: AdminModeratedPost[];
  /** Counted over the whole queue, not the page. */
  summary: { flagged: number; hidden: number; total: number };
};

/**
 * `GET /hostel-admin/community?filter=…`.
 *
 * Scope is decided server-side from the principal: a hostel admin reaches their
 * own hostel's posts and nothing else, so there is no hostel id to send. The
 * summary counts the whole queue rather than the returned page, which is what
 * lets the filter row carry totals the list itself cannot know.
 */
export async function getAdminCommunityModeration(
  filter: AdminModerationFilter,
) {
  const response = await api.get<ApiEnvelope<AdminModeration>>(
    "/hostel-admin/community",
    {
      params: { filter },
    },
  );

  return unwrap(response);
}

/**
 * `PATCH /hostel-admin/community/{postId}/hide` — take a post off the feed.
 *
 * The reason is required (3–500) and is **not** shown to the author; it is for
 * the audit log and for whoever picks the post up next. Hiding also actions
 * every open report on the post, so a hidden post leaves the queue.
 */
export async function hideReportedPost(postId: string, reason: string) {
  await api.patch(`/hostel-admin/community/${postId}/hide`, { reason });
}

/**
 * `DELETE /hostel-admin/community/{postId}/hide` — the opposite verdict.
 *
 * One route doing two jobs, because to the service they are the same write:
 * clear the flag, clear the hidden marks, set the post visible and dismiss its
 * open reports. On a *flagged* post that reads as "this is fine"; on a *hidden*
 * one it reads as "restore". The caller picks the word, the server does not
 * care which was meant.
 */
export async function clearReportedPost(postId: string, reason: string) {
  await api.delete(`/hostel-admin/community/${postId}/hide`, {
    data: { reason },
  });
}

/**
 * `POST /hostel-admin/community` — the one thing only staff can write.
 *
 * An announcement is pinned above that hostel's space. Body is 1–4000; there is
 * no title, deliberately, because the server has no field for one.
 */
export async function postHostelAnnouncement(body: string) {
  await api.post("/hostel-admin/community", { body });
}

/*
 * Where the reduced surface hands over to the full portal: `lib/web-portal.ts`.
 * Kept out of this file because it is pure string work and this one imports the
 * axios client, which reaches React Native and cannot be loaded by Vitest.
 */

/** Hostel KYC — what a hostel still has to finish after it goes live. */
export type HostelKyc = {
  /** Newest first. The file is read through `files/[assetId]/url`. */
  documents: {
    /** The caller uploaded it and it is not approved yet. */
    canRemove?: boolean;
    fileAssetId: string | null;
    fileName: string | null;
    id: string;
    mimeType: string | null;
    rejectionReason: string | null;
    status: "APPROVED" | "PENDING" | "REJECTED";
    type: string;
  }[];
  facilities: string[];
  minPhotos: number;
  percent: number;
  photoCount: number;
  rules: string[];
  steps: { done: boolean; key: string }[];
};

export async function getHostelKyc() {
  const response =
    await api.get<ApiEnvelope<{ kyc: HostelKyc }>>("/hostel-admin/kyc");

  return unwrap(response).kyc;
}

/** Takes back one of the caller's own documents before it is approved. */
export async function removeKycDocument(documentId: string) {
  const response = await api.delete<ApiEnvelope<{ kyc: HostelKyc }>>(
    "/hostel-admin/kyc",
    { params: { documentId } },
  );

  return unwrap(response).kyc;
}

/** Attaches a privately uploaded document (see `uploadPublicFile`). */
export async function addKycDocument(document: {
  claimToken: string;
  documentType: string;
  fileAssetId: string;
}) {
  const response = await api.post<ApiEnvelope<{ kyc: HostelKyc }>>(
    "/hostel-admin/kyc",
    {
      documents: [document],
    },
  );

  return unwrap(response).kyc;
}
