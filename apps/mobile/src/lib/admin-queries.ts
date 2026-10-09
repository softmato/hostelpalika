/**
 * Every read the warden portal makes, named once.
 *
 * ## Why a registry and not a loader per screen
 *
 * A prefetch has to run the *same* request the screen will run, keyed the *same*
 * way, or it warms a key nobody reads and the screen loads twice. Leaving the
 * composite loaders inside the screens made that impossible without the library
 * importing the screens, so they moved here and the screens import them back.
 * One definition, one key, one topic list per question.
 *
 * That is also what makes the keys trustworthy. `admin:money` is not a string
 * typed in two files that have to agree; it is `adminQuery.money(period).key`,
 * and a period that does not reach the key is a bug the type system catches at
 * the call site rather than a screen quietly showing January's invoices in
 * February.
 *
 * ## Two tiers of warming
 *
 * 1. **{@link prefetchAdminPortal}**, the moment the portal opens and again on
 *    every foreground: Home, every tab and every door, in one parallel wave
 *    ordered by what somebody looks at first. Deduplicated against whatever
 *    Home is already loading.
 * 2. **{@link prefetchAdminRoute}** and {@link prefetchAdminResident}, on
 *    touch-down of the thing being opened. This is the catch-all — every
 *    per-id record, where warming ahead of the tap would mean warming forty of
 *    them. Reports is in neither: it is server work, not a list read.
 *
 * ## Every loader here is refusal-tolerant, and that is not incidental
 *
 * A warden's grants are per-flag — `viewPayments`, `viewNightStatus`,
 * `manageFood`, `manageNotices`, `manageMaintenance` — so a prefetch will be
 * refused on some of these for most wardens. Each loader keeps the shape the
 * screen renders and puts `null` where the permission was, exactly as it did
 * when it lived in the screen. A 403 is a section that says so, never an error
 * state and never a cached failure.
 */

import type { AxiosError } from "axios";

import { REALTIME_TOPIC } from "@/constants/topics";
import { isOverall } from "@/lib/active-hostel";
import {
  type AdminAlerts,
  type AdminComplaint,
  type AdminHostel,
  type AdminSubscription,
  type AdminInvoiceMatrix,
  type AdminMaintenance,
  type AdminNightStatus,
  type AdminNotice,
  type AdminPeriodSummary,
  type AdminReport,
  type AdminResident,
  type AdminLedger,
  type AdminModeration,
  type AdminModerationFilter,
  getAdminAlerts,
  getAdminCommunityModeration,
  getAdminFoodRoutine,
  getAdminHostel,
  getAdminSubscription,
  getAdminInvoices,
  getAdminLedger,
  getAdminMaintenance,
  getAdminNightStatus,
  getAdminPeriodSummary,
  getAdminReport,
  listAdminNotices,
  listAdminResidents,
  listAllComplaints,
} from "@/lib/admin-api";
import {
  type AttendanceAnalytics,
  type AttendanceSettings,
  type CommunitySettings,
  type CookAccount,
  type CookPortalSettings,
  type FeeSchedule,
  type FeeScheduleData,
  type FoodAnalytics,
  type GatewayConfig,
  type PlanBilling,
  getAttendanceAnalytics,
  getAttendanceSettings,
  getCommunitySettings,
  getCookPortal,
  getCookRoster,
  getFoodAnalytics,
  getMaintenanceSettings,
  getPlanBilling,
  getManagedHostel,
  getReconciliation,
  getMoveInChecklist,
  getMoveOutChecklist,
  getPaymentProfile,
  getPerformanceReport,
  getResident,
  getResidentLedger,
  listFeeSchedules,
  listRentConcessions,
  type RentConcession,
  listGateways,
  listManagedInquiries,
  listManagedMaintenance,
  listManagedNotices,
  listManagedProviders,
  listNoticePushes,
  getHostelAttendance,
  listMoveEvents,
  type MoveEvent,
  listNotificationCampaigns,
  type NotificationCampaign,
  getHostelInvites,
  type HostelAttendance,
  listAttendanceAlerts,
  type AttendanceAlert,
  type HostelInviteOverview,
  listReferrals,
  listResidentContacts,
  listStatementImports,
  listWardens,
  type MaintenanceCharge,
  type ManagedHostel,
  type ManagedInquiry,
  type ManagedMaintenance,
  type ManagedNotice,
  type ManagedProvider,
  type ManagedResident,
  type NoticePush,
  type ManagedWarden,
  type MoveInChecklist,
  type MoveOutChecklist,
  type PaymentProfile,
  type ReferralsPayload,
  type PerformanceReport,
  type ResidentEmergencyContact,
  type ResidentGuardian,
  type ResidentLedger,
  type StatementImport,
  type ReconciliationView,
} from "@/lib/admin-manage-api";
import { type ResidentScan, scanResident } from "@/lib/admin-scan-api";
import {
  getJoinLink,
  type JoinLink,
  type JoinRequests,
  listJoinRequests,
} from "@/lib/join-api";
import {
  type ExistingResidentsView,
  getExistingResidents,
} from "@/lib/existing-residents-api";
import { nepalPeriodKey } from "@/lib/format";
import { defineQuery, prefetchQuery, type Query } from "@/lib/query-cache";
import { getOverallLedger } from "@/lib/overall-api";
/*
 * Imported for the `AdminTodayData` shape only. It lives in `resident-api`
 * because the resident's week and the admin's routine are the same object seen
 * from two sides.
 */
import type { FoodRoutine } from "@/lib/resident-api";

/**
 * A warden-portal question. The shape, the identity guarantee and the reasoning
 * behind both live in `lib/query-cache.ts`, where they are testable.
 */
export type AdminQuery<T> = Query<T>;

const define = defineQuery;

/* -------------------------------------------------------------------------- */
/* Home                                                                        */
/* -------------------------------------------------------------------------- */

export type AdminOverview = {
  hostel: AdminHostel | null;
  /** Null when the caller's role has no `viewPayments` grant. */
  periods: AdminPeriodSummary | null;
  report: AdminReport;
};

async function loadOverview(): Promise<AdminOverview> {
  const [report, hostel, periods] = await Promise.all([
    getAdminReport(),
    // A warden may be scoped to several hostels, in which case the profile read
    // needs a hostelId it has no way to choose. The numbers above still apply
    // across all of them, so the header simply loses its name.
    getAdminHostel().catch(() => null),
    /*
     * Tolerant for a different reason: `viewPayments` is a per-warden grant, so
     * this is the one read here that a legitimate user can be refused. Falling
     * back rather than failing keeps the rest of the screen — see
     * `earningsSummary`, which decides what the hero says without it.
     */
    getAdminPeriodSummary().catch(() => null),
  ]);

  return { hostel, periods, report };
}

/* -------------------------------------------------------------------------- */
/* Payments                                                                    */
/* -------------------------------------------------------------------------- */

export type AdminMoneyData = {
  hostel: AdminHostel | null;
  invoices: AdminInvoiceMatrix;
  /** Null when the caller's role has no `viewPayments` grant — see below. */
  periods: AdminPeriodSummary | null;
};

async function loadMoney(period: string): Promise<AdminMoneyData> {
  const [invoices, hostel, periods] = await Promise.all([
    getAdminInvoices(period),
    // A warden scoped to several hostels cannot resolve one profile, and the
    // portal link is the only thing that needs it. The figures are unaffected.
    getAdminHostel().catch(() => null),
    /*
     * The monthly roll-up behind the month strip — one chip per month, each
     * carrying its own count of invoices still waiting. Tolerant because
     * `viewPayments` is a per-warden grant and this is the one read here a
     * legitimate user can be refused; the strip is absent in that case rather
     * than drawn as a single empty month.
     */
    getAdminPeriodSummary().catch(() => null),
  ]);

  return { hostel, invoices, periods };
}

/* -------------------------------------------------------------------------- */
/* Today                                                                       */
/* -------------------------------------------------------------------------- */

export type AdminTodayData = {
  maintenance: AdminMaintenance | null;
  night: AdminNightStatus | null;
  notices: AdminNotice[];
  routine: FoodRoutine | null;
};

/**
 * Each source is allowed to fail on its own.
 *
 * A warden's capabilities are per-flag — `viewNightStatus`, `manageFood`,
 * `manageNotices`, `manageMaintenance` are four separate grants — so one 403
 * must not blank the other three sections. Null means "not yours or not
 * reachable", and each section says so in its own words rather than rendering
 * as empty, which is the lie this codebase keeps having to un-tell.
 */
async function loadToday(): Promise<AdminTodayData> {
  const [night, routine, notices, maintenance] = await Promise.all([
    getAdminNightStatus().catch(() => null),
    getAdminFoodRoutine().catch(() => null),
    listAdminNotices().catch(() => [] as AdminNotice[]),
    getAdminMaintenance().catch(() => null),
  ]);

  return { maintenance, night, notices, routine };
}

/* -------------------------------------------------------------------------- */
/* Roll call                                                                   */
/* -------------------------------------------------------------------------- */

export type AdminRollCallData = {
  /** Null when this account has no `viewNightStatus` grant — a 403, not a fault. */
  night: AdminNightStatus | null;
};

/**
 * Ten pages of a hundred.
 *
 * Not a paging strategy — a fuse. The roster is bounded by how many people live
 * in one hostel, so `totalPages` above this means the server is telling us
 * something we do not understand, and a thousand rows is already far past the
 * point where a phone list is the right answer. Better a truncated screen than
 * a launch that fires forty requests.
 */
export const MAX_ROLL_CALL_PAGES = 10;

async function loadRollCall(): Promise<AdminRollCallData> {
  try {
    const first = await getAdminNightStatus();

    if (!first.pagination.hasMore) {
      return { night: first };
    }

    const rest = await Promise.all(
      Array.from(
        { length: Math.min(first.pagination.totalPages, MAX_ROLL_CALL_PAGES) - 1 },
        (_unused, index) => getAdminNightStatus({ page: index + 2 }),
      ),
    );

    return {
      night: {
        ...first,
        statuses: [...first.statuses, ...rest.flatMap((page) => page.statuses)],
      },
    };
  } catch (error) {
    /*
     * Only a 403 becomes "not yours". Everything else — a timeout, a 500, no
     * network — has to stay an error, because rendering the permission card for
     * a server that is merely down tells a warden their access was removed.
     */
    if ((error as AxiosError).response?.status === 403) {
      return { night: null };
    }

    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* One resident                                                                */
/* -------------------------------------------------------------------------- */

export type AdminResidentRecord = {
  contacts: {
    emergencyContacts: ResidentEmergencyContact[];
    guardians: ResidentGuardian[];
  };
  /**
   * Their whole payment history — null when this account cannot see money.
   * `viewPayments` is a separate capability, so a warden who may manage people
   * but not payments still gets the rest of the record.
   */
  ledger: ResidentLedger | null;
  moveIn: MoveInChecklist | null;
  moveOut: MoveOutChecklist | null;
  /** What they owe right now, from the server's ledger — null when it could not be read. */
  owed: number | null;
  resident: ManagedResident;
  roomTypes: string[];
};

async function loadResident(id: string): Promise<AdminResidentRecord> {
  const [resident, contacts, moveIn, moveOut, hostel, ledger] = await Promise.all([
    getResident(id),
    listResidentContacts(id).catch(() => ({ emergencyContacts: [], guardians: [] })),
    getMoveInChecklist(id).catch(() => null),
    getMoveOutChecklist(id).catch(() => null),
    // Only for the room-type picker. A stale list would offer a type that no
    // longer exists, and the move would fail on the server rather than here.
    getManagedHostel().catch(() => null),
    getResidentLedger(id).catch(() => null),
  ]);

  return {
    contacts,
    ledger,
    moveIn,
    moveOut: moveOut?.checklist ?? null,
    owed: moveOut?.pendingFeeAmount ?? null,
    resident,
    roomTypes: (hostel?.roomConfigurations ?? []).map((config) => config.roomType),
  };
}

/* -------------------------------------------------------------------------- */
/* Operations                                                                  */
/* -------------------------------------------------------------------------- */

export type AdminFoodData = {
  cook: CookPortalSettings | null;
  routine: FoodRoutine | null;
};

async function loadFood(): Promise<AdminFoodData> {
  // Independently, and tolerantly. Both routes want `manageFood`, so in practice
  // they fail together — but a cook-portal outage blanking the menu editor would
  // be a bad trade for one shared `Promise.all`.
  const [routine, cook] = await Promise.all([
    getAdminFoodRoutine().catch(() => null),
    getCookPortal().catch(() => null),
  ]);

  return { cook, routine };
}

export type AdminMaintenanceData = {
  /** The owner's agreed call-out floors. Empty until somebody sets them. */
  charges: MaintenanceCharge[];
  maintenance: ManagedMaintenance | null;
  providers: ManagedProvider[];
};

async function loadMaintenance(status: string): Promise<AdminMaintenanceData> {
  const [maintenance, providers, charges] = await Promise.all([
    listManagedMaintenance(status ? { status } : {}).catch(() => null),
    listManagedProviders().catch(() => [] as ManagedProvider[]),
    /*
     * Tolerant, and empty rather than absent on failure. The charges are a
     * convenience on the confirm step; a hostel that has set none is the normal
     * first state, so "could not read them" and "there are none" already look
     * the same to every reader and there is nothing to distinguish.
     */
    getMaintenanceSettings().catch(() => [] as MaintenanceCharge[]),
  ]);

  return { charges, maintenance, providers };
}

export type AdminSettingsData = {
  attendance: AttendanceSettings | null;
  community: CommunitySettings | null;
  hostel: ManagedHostel;
};

async function loadSettings(): Promise<AdminSettingsData> {
  const [hostel, community, attendance] = await Promise.all([
    getManagedHostel(),
    getCommunitySettings().catch(() => null),
    getAttendanceSettings().catch(() => null),
  ]);

  return { attendance, community, hostel };
}

export type AdminReportsData = {
  attendance: AttendanceAnalytics | null;
  food: FoodAnalytics | null;
  report: PerformanceReport;
};

async function loadReports(month: string): Promise<AdminReportsData> {
  const [report, attendance, food] = await Promise.all([
    // Not tolerant: without the report there is no screen, so its failure is
    // the screen's error state rather than an empty page.
    getPerformanceReport(month),
    getAttendanceAnalytics(30).catch(() => null),
    // `reports/food` wants `manageFood`, while the other two only want staff —
    // so this is the one a warden most often cannot see, and it fails alone.
    getFoodAnalytics(30).catch(() => null),
  ]);

  return { attendance, food, report };
}

/* -------------------------------------------------------------------------- */
/* Finance                                                                     */
/* -------------------------------------------------------------------------- */

export type AdminFinanceData = {
  /** Months at reduced rent — the festival discount. `null` when refused. */
  concessions: RentConcession[] | null;
  gateways: GatewayConfig[] | null;
  profile: PaymentProfile | null;
  schedules: FeeSchedule[] | null;
};

async function loadFinance(): Promise<AdminFinanceData> {
  const [schedules, concessions, profile, gateways] = await Promise.all([
    listFeeSchedules()
      .then((data) => data.schedules)
      .catch(() => null),
    // Behind the same capability as the rates it discounts, so it fails with
    // them rather than alone — the screen's Rates block already says why.
    listRentConcessions().catch(() => null),
    getPaymentProfile().catch(() => null),
    // The one read that needs `managePaymentProfile` rather than `viewPayments`
    // — it lists merchant codes and which keys are installed.
    listGateways().catch(() => null),
  ]);

  return { concessions, gateways, profile, schedules };
}

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Every warden-portal question, by name.
 *
 * Parameterised ones are functions, and their argument is in the key. Anything
 * that changes the answer must change the key — that is the whole contract
 * between a screen and a prefetch.
 */
/** `GET /hostel-admin/cooks` — the roster plus the portal switch it drives. */
export type CookRoster = {
  cooks: CookAccount[];
  /** The cook may add expenses — owner's switch, off by default. */
  expensesEnabled?: boolean;
  /** Cooks are asked for a fingerprint lock — owner's switch, off by default. */
  fingerprintLock?: boolean;
  portalEnabled: boolean;
  /** The kitchen may enter what it used from the store — owner's switch, on by default. */
  stockEnabled?: boolean;
};

export const adminQuery = {
  /**
   * The group's shared queue — claims, complaints, inquiries, SOS.
   *
   * Not in {@link prefetchAdminPortal} on purpose: `AdminAlertsProvider` mounts
   * with the layout that runs the warm-up, so it is already asking. What the key
   * buys is the *return* trip — an owner who steps out to the public browse tabs
   * and comes back gets the badges painted rather than counted again.
   */
  alerts: (): AdminQuery<AdminAlerts> =>
    define(
      "admin:alerts",
      [
        REALTIME_TOPIC.PAYMENTS,
        REALTIME_TOPIC.COMPLAINTS,
        REALTIME_TOPIC.INQUIRIES,
        REALTIME_TOPIC.SAFETY,
      ],
      () => getAdminAlerts(),
    ),

  /**
   * When the night prompt is sent, read by the roll-call screen's own card.
   *
   * `admin:settings` carries the same object inside a larger payload, and this
   * is deliberately its own entry: roll-call needs one field of it and must not
   * pull the whole settings screen's read to get it.
   */
  attendanceSettings: (): AdminQuery<AttendanceSettings> =>
    define("admin:attendance-settings", [REALTIME_TOPIC.HOSTELS], () =>
      getAttendanceSettings(),
    ),

  /** Every resident already living here at the moment this hostel joined. */
  existingResidents: (): AdminQuery<ExistingResidentsView> =>
    define("admin:existing-residents", [REALTIME_TOPIC.RESIDENTS], () =>
      getExistingResidents(),
    ),

  /** Residents asking to be added through the join link, and the link itself. */
  joinRequests: (): AdminQuery<JoinRequests> =>
    define("admin:join-requests", [REALTIME_TOPIC.RESIDENTS], () => listJoinRequests()),

  joinLink: (): AdminQuery<JoinLink> =>
    define("admin:join-link", [REALTIME_TOPIC.RESIDENTS], () => getJoinLink()),

  /** The gateway list behind each provider's setup screen. */
  gateways: (): AdminQuery<GatewayConfig[]> =>
    define("admin:gateways", [REALTIME_TOPIC.PAYMENTS], () => listGateways()),

  hostel: (): AdminQuery<AdminHostel | null> =>
    define("admin:hostel", [REALTIME_TOPIC.HOSTELS], () =>
      getAdminHostel().catch(() => null),
    ),

  inquiries: (): AdminQuery<ManagedInquiry[]> =>
    define("admin:inquiries", [REALTIME_TOPIC.INQUIRIES], () =>
      listManagedInquiries(),
    ),

  /**
   * The hostel again, and not a duplicate of `hostel` above.
   *
   * `getAdminHostel` is the dashboard's read — `/hostel-admin/hostel`, the
   * listing as the portal shows it. `getManagedHostel` is `/hostel-admin/profile`
   * and carries the room types and photos the Rooms screen edits. Two endpoints,
   * two shapes, two keys; collapsing them would hand Rooms an object with no
   * `roomTypes` on it.
   */
  managedHostel: (): AdminQuery<ManagedHostel> =>
    define(
      "admin:managed-hostel",
      [REALTIME_TOPIC.HOSTELS, REALTIME_TOPIC.ROOMS],
      () => getManagedHostel(),
    ),

  /**
   * The plan balance behind Home's due banner.
   *
   * Keyed on `PAYMENTS` so settling the due from the banner repaints it without
   * a pull-to-refresh, and on `HOSTELS` because a subscription that activates
   * changes the listing's own state alongside it.
   */
  subscription: (): AdminQuery<AdminSubscription | null> =>
    define(
      "admin:subscription",
      [REALTIME_TOPIC.PAYMENTS, REALTIME_TOPIC.HOSTELS],
      () => getAdminSubscription().catch(() => null),
    ),

  money: (period: string): AdminQuery<AdminMoneyData> =>
    define(
      `admin:money:${period}`,
      [REALTIME_TOPIC.PAYMENTS, REALTIME_TOPIC.RESIDENTS],
      () => loadMoney(period),
    ),

  /** `category` is the screen's own filter; `""` is its default, "all of them". */
  notices: (category: string): AdminQuery<ManagedNotice[]> =>
    define(`admin:notices:${category}`, [REALTIME_TOPIC.NOTICES], () =>
      listManagedNotices({ category }),
    ),

  /** Push notices ride the notices topic: a send also lands on the board. */
  noticePushes: (): AdminQuery<NoticePush[]> =>
    define("admin:notice-pushes", [REALTIME_TOPIC.NOTICES], () => listNoticePushes()),

  overview: (): AdminQuery<AdminOverview> =>
    define(
      "admin:overview",
      [
        REALTIME_TOPIC.PAYMENTS,
        REALTIME_TOPIC.RESIDENTS,
        REALTIME_TOPIC.COMPLAINTS,
        REALTIME_TOPIC.SAFETY,
      ],
      loadOverview,
    ),

  feeSchedules: (): AdminQuery<FeeScheduleData> =>
    define("admin:fee-schedules", [REALTIME_TOPIC.PAYMENTS], () =>
      listFeeSchedules(),
    ),

  /**
   * Plan billing — the hostel paying *us*, not its residents paying it.
   *
   * On the `PAYMENTS` topic like its neighbours even though a plan payment is a
   * different kind of money: the alternative is a topic of its own that fires
   * a handful of times a year per hostel, and a screen that misses a settlement
   * by one refocus is worse than one that revalidates on an unrelated rent
   * payment. Nothing on this screen is expensive to refetch.
   */
  planBilling: (): AdminQuery<PlanBilling> =>
    define("admin:plan-billing", [REALTIME_TOPIC.PAYMENTS], () =>
      getPlanBilling(),
    ),

  finance: (): AdminQuery<AdminFinanceData> =>
    define("admin:finance", [REALTIME_TOPIC.PAYMENTS], loadFinance),

  complaints: (): AdminQuery<AdminComplaint[]> =>
    define("admin:complaints", [REALTIME_TOPIC.COMPLAINTS], listAllComplaints),

  food: (): AdminQuery<AdminFoodData> =>
    define("admin:food", [REALTIME_TOPIC.FOOD], loadFood),

  ledger: (): AdminQuery<AdminLedger> =>
    // Overall's statement is every branch merged; the cache keeps it apart by scope.
    define("admin:ledger", [REALTIME_TOPIC.PAYMENTS], () => (isOverall() ? getOverallLedger() : getAdminLedger())),

  /** `status` is the screen's filter; `""` is its default, every request. */
  maintenance: (status: string): AdminQuery<AdminMaintenanceData> =>
    define(`admin:maintenance:${status}`, [REALTIME_TOPIC.MAINTENANCE], () =>
      loadMaintenance(status),
    ),

  moderation: (filter: AdminModerationFilter): AdminQuery<AdminModeration> =>
    define(`admin:moderation:${filter}`, [REALTIME_TOPIC.COMMUNITY], () =>
      getAdminCommunityModeration(filter),
    ),

  paymentProfile: (): AdminQuery<PaymentProfile> =>
    define("admin:payment-profile", [REALTIME_TOPIC.PAYMENTS], () =>
      getPaymentProfile(),
    ),

  referrals: (filter: string): AdminQuery<ReferralsPayload> =>
    define(`admin:referrals:${filter}`, [], () => listReferrals(filter)),

  /** Every move-in and move-out, newest first. */
  moveHistory: (): AdminQuery<MoveEvent[]> =>
    define("admin:move-history", [REALTIME_TOPIC.RESIDENTS], () => listMoveEvents()),

  /** Sent and scheduled notification campaigns, newest first. */
  campaigns: (): AdminQuery<NotificationCampaign[]> =>
    define("admin:campaigns", [], () => listNotificationCampaigns()),

  /** Location attendance: today's zones and the open absence alerts, one read. */
  attendance: (): AdminQuery<{ alerts: AttendanceAlert[]; attendance: HostelAttendance }> =>
    define("admin:attendance", [], async () => {
      const [attendance, alerts] = await Promise.all([getHostelAttendance(), listAttendanceAlerts()]);

      return { alerts, attendance };
    }),

  /** Invite hostels: this hostel's code, its link, and who used it. */
  hostelInvites: (): AdminQuery<HostelInviteOverview> =>
    define("admin:hostel-invites", [], () => getHostelInvites()),

  /**
   * The month is in the key, and the month is the only thing the screen varies.
   * `""` is its default — whatever the server calls the current one.
   */
  reports: (month: string): AdminQuery<AdminReportsData> =>
    define(`admin:reports:${month}`, [], () => loadReports(month)),

  /**
   * One resident's whole record: profile, contacts, both checklists, the ledger
   * and the room-type list behind the move picker.
   *
   * Six requests, which is why this one is worth warming on touch-down of a
   * roster row — it is the slowest screen in the portal to open and the one an
   * owner opens most often.
   */
  resident: (id: string): AdminQuery<AdminResidentRecord> =>
    define(
      `admin:resident:${id}`,
      [REALTIME_TOPIC.RESIDENTS, REALTIME_TOPIC.PAYMENTS],
      () => loadResident(id),
    ),

  residents: (): AdminQuery<AdminResident[]> =>
    define("admin:residents", [REALTIME_TOPIC.RESIDENTS], () =>
      listAdminResidents(),
    ),

  rollCall: (): AdminQuery<AdminRollCallData> =>
    define(
      "admin:roll-call",
      [REALTIME_TOPIC.ATTENDANCE, REALTIME_TOPIC.SAFETY],
      loadRollCall,
    ),

  settings: (): AdminQuery<AdminSettingsData> =>
    define("admin:settings", [REALTIME_TOPIC.HOSTELS], loadSettings),

  /**
   * One import's reconciliation, keyed on the import — the screen scrubs
   * between them and a shared entry would show another statement's matches.
   */
  reconciliation: (statementImportId: string): AdminQuery<ReconciliationView> =>
    define(`admin:reconciliation:${statementImportId}`, [REALTIME_TOPIC.PAYMENTS], () =>
      getReconciliation(statementImportId),
    ),

  /**
   * What a scanned card says about one resident. Keyed on the resident, and
   * short-lived by nature — the screen is opened from the camera and left.
   */
  residentScan: (residentId: string): AdminQuery<ResidentScan> =>
    define(`admin:resident-scan:${residentId}`, [REALTIME_TOPIC.RESIDENTS], () =>
      scanResident(residentId),
    ),

  statementImports: (): AdminQuery<StatementImport[]> =>
    define("admin:statement-imports", [REALTIME_TOPIC.PAYMENTS], () =>
      listStatementImports(),
    ),

  today: (): AdminQuery<AdminTodayData> =>
    define(
      "admin:today",
      [
        REALTIME_TOPIC.ATTENDANCE,
        REALTIME_TOPIC.FOOD,
        REALTIME_TOPIC.MAINTENANCE,
        REALTIME_TOPIC.NOTICES,
        REALTIME_TOPIC.SAFETY,
      ],
      loadToday,
    ),
  /**
   * The kitchen roster. No realtime topic: cooks change when an admin changes
   * them, on this screen, and the screen reloads itself after each write.
   */
  cooks: (): AdminQuery<CookRoster> => define("admin:cooks", [], () => getCookRoster()),
  wardens: (): AdminQuery<ManagedWarden[]> =>
    define("admin:wardens", [], () => listWardens()),
} as const;

/** Warms one descriptor. Never throws, never re-asks something already fresh. */
export function prefetchAdminQuery<T>(query: AdminQuery<T>) {
  prefetchQuery(query.key, query.load, { topics: query.topics });
}

/**
 * Everything the portal reads, warmed in one parallel wave the moment it opens.
 *
 * Listed in the order somebody will look at it — Home, the tabs, then every
 * door behind Home's grid and More — because the native HTTP dispatcher runs
 * a host's requests in the order they were issued. Home's own `useResource`
 * already asked by the time this runs (child effects fire first), so its keys
 * here join that request rather than making a second.
 *
 * Two absences are deliberate:
 *
 * - **Reports** runs a month of attendance and food analytics on the server.
 *   Speculatively starting real work is a different trade from speculatively
 *   reading a list; it is cached once opened, never started by a guess.
 * - **One resident's record** is keyed by id and six requests deep; the rows
 *   that know the id warm it on touch-down.
 *
 * Community and the bell's feed are warmed by `RoleTabs`, for every shell.
 */
export function prefetchAdminPortal() {
  // Home.
  prefetchAdminQuery(adminQuery.overview());
  prefetchAdminQuery(adminQuery.subscription());
  prefetchAdminQuery(adminQuery.alerts());
  // The tabs.
  prefetchAdminQuery(adminQuery.today());
  prefetchAdminQuery(adminQuery.residents());
  prefetchAdminQuery(adminQuery.money(nepalPeriodKey()));
  prefetchAdminQuery(adminQuery.hostel());
  // The doors.
  prefetchAdminQuery(adminQuery.rollCall());
  prefetchAdminQuery(adminQuery.food());
  prefetchAdminQuery(adminQuery.maintenance(""));
  prefetchAdminQuery(adminQuery.notices(""));
  prefetchAdminQuery(adminQuery.inquiries());
  prefetchAdminQuery(adminQuery.finance());
  prefetchAdminQuery(adminQuery.managedHostel());
  prefetchAdminQuery(adminQuery.settings());
  prefetchAdminQuery(adminQuery.ledger());
  prefetchAdminQuery(adminQuery.feeSchedules());
  prefetchAdminQuery(adminQuery.paymentProfile());
  prefetchAdminQuery(adminQuery.planBilling());
  prefetchAdminQuery(adminQuery.statementImports());
  prefetchAdminQuery(adminQuery.cooks());
  prefetchAdminQuery(adminQuery.wardens());
  prefetchAdminQuery(adminQuery.referrals(""));
  prefetchAdminQuery(adminQuery.moderation("flagged"));
}

/**
 * The href a button is about to push → the question that screen will ask.
 *
 * Every destination in the portal whose first paint is a network read is here,
 * because the whole point is that no screen reached from a tile or a row makes
 * the reader watch it load. Two kinds of route are absent, and both should stay
 * absent:
 *
 * - **Nothing to warm.** `manage/scan` opens a camera and
 *   `manage/resident/new` opens an empty form.
 * - **Warming would be the work.** `manage/reports` runs analytics over a month
 *   of attendance and food on the server. Touch-down is the right trigger for a
 *   read; it is the wrong trigger for a report run that the tap may not follow.
 *   Reports is still *cached* — opening it twice is one run — it is simply not
 *   speculatively started.
 *
 * Unknown hrefs are a no-op rather than a throw. This is called from press
 * handlers on grids and lists whose contents change, and a tile added without an
 * entry here must cost a hundred milliseconds, not a crash.
 */
export function prefetchAdminRoute(href: string) {
  switch (href) {
    case "/(admin)/alerts":
      prefetchAdminQuery(adminQuery.alerts());
      return;
    case "/(admin)/community-reports":
      prefetchAdminQuery(adminQuery.moderation("flagged"));
      return;
    case "/(admin)/money":
      prefetchAdminQuery(adminQuery.money(nepalPeriodKey()));
      return;
    case "/(admin)/residents":
      prefetchAdminQuery(adminQuery.residents());
      return;
    case "/(admin)/today":
      prefetchAdminQuery(adminQuery.today());
      return;
    case "/manage/billing":
      prefetchAdminQuery(adminQuery.planBilling());
      return;
    case "/manage/finance":
    /*
     * The festival-discount screen reads `adminQuery.finance()` too — the same
     * key, because the discounts arrive with the rates they sit on top of. So
     * warming either warms both, exactly as the two rate-card views do below.
     */
    case "/manage/finance/month-discounts":
      prefetchAdminQuery(adminQuery.finance());
      return;
    /*
     * The rate card, not the finance summary: `finance/room-rates`,
     * `finance/rates` and `finance/history` are three views of one list and
     * share the key, so warming any warms all.
     */
    case "/manage/finance/history":
    case "/manage/finance/room-rates":
    case "/manage/finance/rates":
      prefetchAdminQuery(adminQuery.feeSchedules());
      return;
    case "/manage/finance/payment-setup":
      prefetchAdminQuery(adminQuery.paymentProfile());
      return;
    case "/manage/finance/statement":
      prefetchAdminQuery(adminQuery.ledger());
      prefetchAdminQuery(adminQuery.hostel());
      return;
    case "/manage/cook":
      prefetchAdminQuery(adminQuery.cooks());
      return;
    case "/manage/food":
      prefetchAdminQuery(adminQuery.food());
      return;
    case "/manage/inquiries":
      prefetchAdminQuery(adminQuery.inquiries());
      return;
    case "/manage/maintenance":
      prefetchAdminQuery(adminQuery.maintenance(""));
      return;
    case "/manage/complaints":
      prefetchAdminQuery(adminQuery.complaints());
      return;
    case "/manage/notices":
      prefetchAdminQuery(adminQuery.notices(""));
      return;
    case "/manage/push-notices":
      prefetchAdminQuery(adminQuery.noticePushes());
      return;
    case "/manage/referrals":
      prefetchAdminQuery(adminQuery.referrals(""));
      return;
    case "/manage/announcements":
      prefetchAdminQuery(adminQuery.campaigns());
      return;
    case "/manage/attendance":
      prefetchAdminQuery(adminQuery.attendance());
      return;
    case "/manage/invite-hostels":
      prefetchAdminQuery(adminQuery.hostelInvites());
      return;
    case "/manage/roll-call":
      prefetchAdminQuery(adminQuery.rollCall());
      return;
    case "/manage/rooms":
      prefetchAdminQuery(adminQuery.managedHostel());
      return;
    case "/manage/settings":
      prefetchAdminQuery(adminQuery.settings());
      return;
    case "/manage/statements":
      prefetchAdminQuery(adminQuery.statementImports());
      return;
    case "/manage/wardens":
      prefetchAdminQuery(adminQuery.wardens());
      return;
    default:
  }
}

/**
 * One resident's record, warmed from wherever their name is on screen.
 *
 * Separate from {@link prefetchAdminRoute} because the id is the point: the
 * roster, the money list and the invoice sheet all lead to
 * `manage/resident/[id]`, and each of them knows *which* resident before the tap
 * lands. Six requests deep, it is the slowest open in the portal.
 *
 * Deliberately **not** applied to every visible row on mount. A forty-person
 * roster would be two hundred and forty requests to save one tap's wait, which
 * is not a trade any of this is trying to make.
 */
export function prefetchAdminResident(id: string) {
  if (!id) {
    return;
  }

  prefetchAdminQuery(adminQuery.resident(id));
}
