import { Types, type PipelineStage } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { paginationMeta, paginationRange, type PaginationQuery } from "@/lib/pagination";
import { addBsMonths, bsPeriodBounds, hostelPeriodOf, isBsPeriod } from "@/lib/hostel-day";
import { assertHostelAccess } from "@/lib/tenant";
import { ComplaintModel } from "@hostel/db/models/Complaint";
import { FoodFeedbackModel } from "@hostel/db/models/FoodFeedback";
import { HostelModel } from "@hostel/db/models/Hostel";
import { InquiryModel } from "@hostel/db/models/Inquiry";
import { ListingFlagModel } from "@hostel/db/models/ListingFlag";
import { MaintenanceRequestModel } from "@hostel/db/models/MaintenanceRequest";
import { NightStatusModel } from "@hostel/db/models/NightStatus";
import {
  collectionTotals,
  countInvoicesByField,
  invoicesByIds,
  listRecentInvoices,
  monthlySeries,
  type LedgerScope,
} from "@/modules/finance/ledger-read.service";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";
import { RatingReviewModel } from "@hostel/db/models/RatingReview";
import { ReferralModel } from "@hostel/db/models/Referral";
import { ReferralRewardModel } from "@hostel/db/models/ReferralReward";
import { ResidentModel } from "@hostel/db/models/Resident";
import { ServiceProviderModel } from "@hostel/db/models/ServiceProvider";
import { getHostelViewStats } from "@/modules/hostels/hostel-view.service";
import { periodOf } from "@/modules/finance/billing.service";
import { countableResidentIds } from "@/modules/finance/resident-scope";
import { getStatementNudge } from "@/modules/finance/statements/statement-nudge";
import type { reportQuerySchema } from "@/modules/reports/report.validation";

type ReportQuery = z.infer<typeof reportQuerySchema>;

export class ReportServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "REPORT_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

function normalizeObjectId(value: string, label = "id") {
  if (!Types.ObjectId.isValid(value)) {
    throw new ReportServiceError(`Invalid ${label}.`, "INVALID_OBJECT_ID", 422);
  }

  return new Types.ObjectId(value);
}

function normalizeObjectIds(values: string[]) {
  return values.map((value) => normalizeObjectId(value, "hostel id"));
}

export function hostelFilter(principal: ApiPrincipal, requestedHostelId?: string) {
  if (requestedHostelId) {
    assertHostelAccess(principal, requestedHostelId);
    return { hostelId: normalizeObjectId(requestedHostelId, "hostel id") };
  }

  return {
    hostelId: {
      $in: normalizeObjectIds(principal.hostelIds),
    },
  };
}

/**
 * The instants a reported month opens and closes on.
 *
 * `query.month` is an `Invoice.period` — a **Bikram Sambat** month — and this
 * split it on the hyphen and fed the two numbers to `Date.UTC`. `2083-05` read
 * that way is May of the year 2083 AD, so the claim count filtered on a window
 * fifty-seven years in the future and came back zero on every report, under
 * totals that were right because they matched on the period string instead.
 *
 * Both ends are returned together because they are one decision. Returns `null`
 * for a month it cannot bound — a pre-cutover Gregorian key, or a year past the
 * conversion table — and the caller drops the date window rather than reporting
 * a hostel's claims against a window nobody can name.
 */
function monthWindow(month?: string): { end: Date; start: Date } | null {
  if (!month || !isBsPeriod(month)) {
    return null;
  }

  try {
    const { end, start } = bsPeriodBounds(month);

    return { end, start };
  } catch {
    return null;
  }
}

/**
 * Vacancy is a running count on each hostel's roomConfigurations rather than a
 * collection of bed records, so this sums the per-room-type figures.
 */
async function countVacantBeds(hostelIds: Types.ObjectId[]) {
  const hostels = await HostelModel.find({
    _id: { $in: hostelIds },
    isDeleted: false,
  })
    .select("roomConfigurations")
    .lean<Array<{ roomConfigurations?: Array<{ vacantBeds?: number }> }>>();

  return hostels.reduce(
    (total, hostel) =>
      total +
      (hostel.roomConfigurations ?? []).reduce(
        (sum, config) => sum + (config.vacantBeds ?? 0),
        0,
      ),
    0,
  );
}

/**
 * Turns this file's `{ hostelId }` / `{ hostelId: { $in } }` scoping into a
 * {@link LedgerScope}.
 *
 * Every payment read in this service goes through the ledger facade (ADR-3),
 * which takes a scope rather than a Mongo filter — so `Payment`'s field names
 * (`month`, `dueAmount`, `paidAmount`) stay behind the facade instead of being
 * hard-coded here, where the cutover would have to unpick them.
 */
export function ledgerScopeFrom(
  scoped: { hostelId: Types.ObjectId | { $in: Types.ObjectId[] } },
  extra: Omit<LedgerScope, "hostelId" | "hostelIds"> = {},
): LedgerScope {
  if (scoped.hostelId instanceof Types.ObjectId) {
    return { hostelId: scoped.hostelId, ...extra };
  }

  return { hostelIds: scoped.hostelId.$in, ...extra };
}

async function countByField(
  model: {
    aggregate: <T>(pipeline: PipelineStage[]) => {
      exec: () => Promise<T[]>;
    };
  },
  filter: Record<string, unknown>,
  field: string,
) {
  const rows = await model
    .aggregate<{
      _id: string;
      count: number;
    }>([
      { $match: filter },
      { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ])
    .exec();

  return Object.fromEntries(rows.map((row) => [row._id ?? "UNKNOWN", row.count]));
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TREND_WINDOW_DAYS = 30;
const SERIES_BUCKETS = 5;
const SERIES_BUCKET_DAYS = 7;

type CountingModel = {
  countDocuments: (
    filter: Record<string, unknown>,
  ) => Promise<number> | { then: unknown };
};

/**
 * Percent change of "documents created in the last 30 days" against the 30 days
 * before that. Returned as a signed number so the client only formats it — a
 * null `changePercent` means the previous window was empty and a ratio would be
 * meaningless (the client shows the raw delta instead).
 */
async function windowTrend(
  model: CountingModel,
  filter: Record<string, unknown>,
  now: Date,
  dateField = "createdAt",
) {
  const currentStart = new Date(now.getTime() - TREND_WINDOW_DAYS * DAY_MS);
  const previousStart = new Date(now.getTime() - 2 * TREND_WINDOW_DAYS * DAY_MS);

  const [current, previous] = await Promise.all([
    model.countDocuments({
      ...filter,
      [dateField]: { $gte: currentStart },
    }) as Promise<number>,
    model.countDocuments({
      ...filter,
      [dateField]: { $gte: previousStart, $lt: currentStart },
    }) as Promise<number>,
  ]);

  return {
    changePercent:
      previous > 0 ? Number((((current - previous) / previous) * 100).toFixed(1)) : null,
    current,
    previous,
  };
}

function bucketBoundaries(now: Date) {
  return Array.from({ length: SERIES_BUCKETS }, (_, index) => {
    const end = new Date(
      now.getTime() - (SERIES_BUCKETS - 1 - index) * SERIES_BUCKET_DAYS * DAY_MS,
    );
    return { end, start: new Date(end.getTime() - SERIES_BUCKET_DAYS * DAY_MS) };
  });
}

/** Weekly counts over the last five weeks, used by the dashboard sparklines. */
async function weeklyCounts(
  model: CountingModel,
  filter: Record<string, unknown>,
  now: Date,
  dateField = "createdAt",
) {
  return Promise.all(
    bucketBoundaries(now).map(
      (bucket) =>
        model.countDocuments({
          ...filter,
          [dateField]: { $gte: bucket.start, $lt: bucket.end },
        }) as Promise<number>,
    ),
  );
}

async function weeklyPaidAmounts(now: Date) {
  const buckets = bucketBoundaries(now);

  return Promise.all(
    buckets.map(async (bucket) => {
      const totals = await collectionTotals({
        settledFrom: bucket.start,
        settledTo: bucket.end,
      });

      return totals.paidAmount;
    }),
  );
}

export async function getPlatformDashboardReport() {
  await connectToDatabase();

  const now = new Date();

  const [
    totalHostels,
    pendingApprovals,
    activeResidents,
    inquiries,
    serviceProviders,
    complaints,
    reviews,
    openListingFlags,
    paymentTotals,
  ] = await Promise.all([
    HostelModel.countDocuments({ isDeleted: false }),
    HostelModel.countDocuments({ isDeleted: false, status: "PENDING_APPROVAL" }),
    ResidentModel.countDocuments({ isDeleted: false, status: "ACTIVE" }),
    InquiryModel.countDocuments({ isDeleted: false }),
    ServiceProviderModel.countDocuments({ isDeleted: false }),
    ComplaintModel.countDocuments({}),
    RatingReviewModel.countDocuments({}),
    ListingFlagModel.countDocuments({ isDeleted: false, status: "OPEN" }),
    collectionTotals({}),
  ]);

  const [
    hostelTrend,
    pendingTrend,
    residentTrend,
    inquiryTrend,
    serviceProviderTrend,
    complaintTrend,
    revenueCurrent,
    revenuePrevious,
    hostelSeries,
    inquirySeries,
    revenueSeries,
  ] = await Promise.all([
    windowTrend(HostelModel, { isDeleted: false }, now),
    windowTrend(HostelModel, { isDeleted: false, status: "PENDING_APPROVAL" }, now),
    windowTrend(ResidentModel, { isDeleted: false, status: "ACTIVE" }, now),
    windowTrend(InquiryModel, { isDeleted: false }, now),
    windowTrend(ServiceProviderModel, { isDeleted: false }, now),
    windowTrend(ComplaintModel, {}, now),
    collectionTotals({
      settledFrom: new Date(now.getTime() - TREND_WINDOW_DAYS * DAY_MS),
    }),
    collectionTotals({
      settledFrom: new Date(now.getTime() - 2 * TREND_WINDOW_DAYS * DAY_MS),
      settledTo: new Date(now.getTime() - TREND_WINDOW_DAYS * DAY_MS),
    }),
    weeklyCounts(HostelModel, { isDeleted: false }, now),
    weeklyCounts(InquiryModel, { isDeleted: false }, now),
    weeklyPaidAmounts(now),
  ]);

  const revenueTrend = {
    changePercent:
      revenuePrevious.paidAmount > 0
        ? Number(
            (
              ((revenueCurrent.paidAmount - revenuePrevious.paidAmount) /
                revenuePrevious.paidAmount) *
              100
            ).toFixed(1),
          )
        : null,
    current: revenueCurrent.paidAmount,
    previous: revenuePrevious.paidAmount,
  };

  return {
    report: {
      activeResidents,
      complaints,
      inquiries,
      openListingFlags,
      outstandingPayments: Math.max(
        paymentTotals.dueAmount - paymentTotals.paidAmount,
        0,
      ),
      pendingApprovals,
      // Real ledger roll-up: every payment residents have actually settled.
      // Subscription billing is still outside the pilot schema.
      platformPayments: paymentTotals.paidAmount,
      reviews,
      serviceProviders,
      series: {
        bucketDays: SERIES_BUCKET_DAYS,
        hostels: hostelSeries,
        inquiries: inquirySeries,
        labels: bucketBoundaries(now).map((bucket) => bucket.end.toISOString()),
        revenue: revenueSeries,
      },
      totalHostels,
      trends: {
        activeResidents: residentTrend,
        complaints: complaintTrend,
        inquiries: inquiryTrend,
        pendingApprovals: pendingTrend,
        platformPayments: revenueTrend,
        serviceProviders: serviceProviderTrend,
        totalHostels: hostelTrend,
      },
      windowDays: TREND_WINDOW_DAYS,
    },
  };
}

/**
 * A resident claim awaiting review.
 *
 * Was a `PaymentProof` row; since item 2.8 it is a `PENDING` `PaymentEvent` with
 * `source: "RESIDENT_CLAIM"`. The shape below is what the platform screen reads,
 * mapped from the event's own fields — `occurredAt` for `submittedAt`, the
 * resident-typed code out of `rawPayload` where it stays unindexed.
 */
type PlatformPaymentProofRecord = {
  _id: Types.ObjectId;
  amount: number;
  evidenceAssetId?: Types.ObjectId;
  hostelId: Types.ObjectId;
  invoiceId?: Types.ObjectId;
  occurredAt?: Date;
  rawPayload?: { transactionCode?: string };
  residentId: Types.ObjectId;
  status: string;
};

/** Claims waiting on a human, in whatever scope the caller is reporting on. */
export const PENDING_CLAIM_FILTER = { source: "RESIDENT_CLAIM", status: "PENDING" };

/** Actual receipts, rather than invoices that may never have been paid. */
export async function getRecentPlatformPayments(query: PaginationQuery = {}) {
  await connectToDatabase();
  const hostels = await HostelModel.find({ isDeleted: false })
    .select("_id name")
    .lean<Array<{ _id: Types.ObjectId; name: string }>>();
  const filter = {
    hostelId: { $in: hostels.map((hostel) => hostel._id) },
    status: "SETTLED",
    direction: "CREDIT",
  };
  const { skip, limit } = paginationRange(query);
  const [events, total] = await Promise.all([
    PaymentEventModel.find(filter).sort({ settledAt: -1, _id: -1 })
      .skip(skip).limit(limit)
      .lean<Array<{ _id: Types.ObjectId; hostelId: Types.ObjectId; amount: number; provider: string; settledAt?: Date; occurredAt?: Date }>>(),
    PaymentEventModel.countDocuments(filter),
  ]);
  const names = new Map(hostels.map((hostel) => [String(hostel._id), hostel.name]));
  return {
    pagination: paginationMeta(query, total),
    recent: events.map((event) => ({
      id: String(event._id),
      hostelName: names.get(String(event.hostelId)) ?? "—",
      paidAmount: event.amount,
      provider: event.provider,
      status: "SETTLED",
      paidAt: (event.settledAt ?? event.occurredAt)?.toISOString() ?? null,
    })),
  };
}

// Read-only, platform-wide roll-up of resident payment records (no hostel
// scoping) for the Platform Owner "Payments" tab. Manual/gateway billing stays
// out of scope; this simply aggregates what admins have already recorded.
export async function getPlatformPaymentsOverview() {
  await connectToDatabase();

  // Scoped to hostels that are still on the platform. An archived hostel is
  // waiting to be erased and is no longer part of the platform's book — leaving
  // its invoices in these totals means the money a superadmin reads here stops
  // matching the money anyone can act on, and stays wrong for the whole 60-day
  // grace period. The rows are erased by the purge; until then they are simply
  // out of scope.
  const liveHostels = await HostelModel.find({ isDeleted: false })
    .select("_id")
    .lean<Array<{ _id: Types.ObjectId }>>();
  const liveHostelIds = liveHostels.map((hostel) => hostel._id);
  const liveScope = { hostelIds: liveHostelIds };
  const livePendingClaims = {
    hostelId: { $in: liveHostelIds },
    ...PENDING_CLAIM_FILTER,
  };

  const [totals, statusCounts, pendingProofs, recent, proofs] = await Promise.all([
    collectionTotals(liveScope),
    countInvoicesByField(liveScope, "status"),
    PaymentEventModel.countDocuments(livePendingClaims),
    listRecentInvoices(liveScope, 25),
    PaymentEventModel.find(livePendingClaims)
      .sort({ occurredAt: -1 })
      .limit(10)
      .lean<PlatformPaymentProofRecord[]>(),
  ]);

  // Resolve hostel names for both the payment rows and the pending proof queue
  // in one query rather than one per row.
  const hostelIds = [
    ...new Set([
      ...recent.map((payment) => payment.hostelId.toString()),
      ...proofs.map((proof) => proof.hostelId.toString()),
    ]),
  ];
  const hostels = await HostelModel.find({ _id: { $in: hostelIds } })
    .select("name")
    .lean<Array<{ _id: Types.ObjectId; name?: string }>>();
  const nameById = new Map(
    hostels.map((hostel) => [hostel._id.toString(), hostel.name ?? "—"]),
  );

  const paymentById = await invoicesByIds(
    proofs.map((proof) => proof.invoiceId).filter(Boolean) as Types.ObjectId[],
  );

  return {
    overview: {
      outstanding: Math.max(totals.dueAmount - totals.paidAmount, 0),
      pendingProofs,
      statusCounts,
      totalDue: totals.dueAmount,
      totalPaid: totals.paidAmount,
    },
    proofs: proofs.map((proof) => {
      const payment = proof.invoiceId
        ? paymentById.get(proof.invoiceId.toString())
        : undefined;

      return {
        // The claimed amount, not the invoice total: a part payment claims part
        // of the month, and showing the total overstates what is being reviewed.
        amount: proof.amount,
        hostelName: nameById.get(proof.hostelId.toString()) ?? "—",
        id: proof._id.toString(),
        month: payment?.period ?? "—",
        paymentId: proof.invoiceId?.toString() ?? "",
        proofImageAssetId: proof.evidenceAssetId?.toString() ?? "",
        residentId: proof.residentId.toString(),
        status: proof.status,
        submittedAt: proof.occurredAt?.toISOString() ?? null,
        transactionCode: proof.rawPayload?.transactionCode ?? "",
      };
    }),
    recent: recent.map((payment) => ({
      dueAmount: payment.dueAmount,
      dueDate: payment.dueDate?.toISOString() ?? null,
      hostelName: nameById.get(payment.hostelId) ?? "—",
      id: payment.id,
      month: payment.period,
      paidAmount: payment.paidAmount,
      status: payment.status,
    })),
  };
}

/**
 * The admin dashboard is three sequential waves of queries — the countable
 * resident ids, then nine parallel counts, then the statement nudge — and it is
 * the first thing every staff member loads. A short memo removes all of it on a
 * hit, for a fraction of the diff a `$facet` rewrite would cost.
 *
 * Keyed on the **resolved** hostel scope rather than `query.hostelId`, because
 * that is what the numbers are derived from: a principal who omits the query
 * parameter gets every hostel they may see, and two principals with different
 * access must never share an entry.
 *
 * ponytail: per Fluid instance and unbounded between expiries — it holds one
 * small object per active hostel scope, pruned on read.
 */
const DASHBOARD_CACHE_MS = 30 * 1000;

const dashboardCache = new Map<
  string,
  { at: number; value: Awaited<ReturnType<typeof buildHostelAdminDashboardReport>> }
>();

/**
 * Empties the memo. Production never needs this — entries expire on their own —
 * but a test that asserts on the queries the report makes must be able to start
 * from a cold cache, or the second case in a file silently asserts against the
 * first one's answer.
 */
export function resetHostelAdminDashboardCache() {
  dashboardCache.clear();
}

export async function getHostelAdminDashboardReport(
  query: ReportQuery,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const scoped = hostelFilter(principal, query.hostelId);
  // hostelFilter yields either `{ hostelId: ObjectId }` or `{ hostelId: { $in } }`;
  // the view stats query needs the plain list either way.
  const scopedHostelIds =
    scoped.hostelId instanceof Types.ObjectId ? [scoped.hostelId] : scoped.hostelId.$in;

  const cacheKey = scopedHostelIds
    .map((id) => id.toString())
    .sort()
    .join(",");
  const now = Date.now();

  for (const [key, entry] of dashboardCache) {
    if (now - entry.at >= DASHBOARD_CACHE_MS) {
      dashboardCache.delete(key);
    }
  }

  const hit = dashboardCache.get(cacheKey);

  if (hit) {
    return hit.value;
  }

  const value = await buildHostelAdminDashboardReport(scoped, scopedHostelIds);

  dashboardCache.set(cacheKey, { at: Date.now(), value });

  return value;
}

async function buildHostelAdminDashboardReport(
  scoped: ReturnType<typeof hostelFilter>,
  scopedHostelIds: Types.ObjectId[],
) {

  /**
   * Two corrections to what `monthlyDues` and `paidAmount` used to mean.
   *
   * **It was not monthly.** The scope carried a hostel and nothing else, so a
   * card labelled "Monthly Dues" summed every invoice the hostel had ever
   * issued — including months already settled. It grew forever and matched no
   * figure on the payments screen.
   *
   * **It counted deleted residents.** Same defect as the matrix and the month
   * picker: soft-deleted residents keep their invoices in the ledger, and each
   * reader was deciding separately whether those count. `countableResidentIds`
   * is now the single answer.
   */
  const residentIds = (
    await Promise.all(scopedHostelIds.map((id) => countableResidentIds(id)))
  ).flat();
  const paymentFilter = ledgerScopeFrom(scoped, {
    period: periodOf(new Date()),
    residentIds,
  });

  const [
    residents,
    vacantBeds,
    paymentTotals,
    pendingPaymentProofs,
    complaints,
    maintenanceRequests,
    foodFeedback,
    nightStatusSummary,
    viewStats,
  ] = await Promise.all([
    // `$ne: true`, not `=== false`, matching every other resident read: a row
    // written without the field would otherwise be counted by one and not the
    // other.
    ResidentModel.countDocuments({ ...scoped, isDeleted: { $ne: true } }),
    countVacantBeds(scopedHostelIds),
    collectionTotals(paymentFilter),
    PaymentEventModel.countDocuments({
      ...scoped,
      ...PENDING_CLAIM_FILTER,
      residentId: { $in: residentIds },
    }),
    ComplaintModel.countDocuments(scoped),
    MaintenanceRequestModel.countDocuments({ ...scoped, isDeleted: false }),
    FoodFeedbackModel.countDocuments(scoped),
    countByField(NightStatusModel, scoped, "status"),
    getHostelViewStats(scopedHostelIds),
  ]);

  // Only meaningful for a single hostel: a multi-hostel admin's dashboard would
  // otherwise nudge about whichever one happens to sort first, which is worse
  // than not nudging at all.
  const statementNudge =
    scopedHostelIds.length === 1
      ? await getStatementNudge(scopedHostelIds[0]!)
      : null;

  return {
    statementNudge,
    report: {
      complaints,
      foodFeedback,
      maintenanceRequests,
      monthlyDues: paymentTotals.dueAmount,
      paidAmount: paymentTotals.paidAmount,
      pendingPaymentProofs,
      publicViewsLast30Days: viewStats.publicViewsLast30Days,
      residents,
      totalPublicViews: viewStats.totalPublicViews,
      uniquePublicVisitors: viewStats.uniquePublicVisitors,
      vacantBeds,
      nightStatusSummary,
    },
  };
}

export async function getHostelAdminPaymentsReport(
  query: ReportQuery,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const scoped = hostelFilter(principal, query.hostelId);
  const filter = ledgerScopeFrom(scoped, query.month ? { period: query.month } : {});
  const window = monthWindow(query.month);

  const proofFilter: Record<string, unknown> = { ...scoped };

  if (window) {
    // `$lte` against `end`, which is the month's last millisecond. `lastDay` is
    // the other half of `bsPeriodBounds` and belongs to due dates, not to
    // ranges — using it here would drop everything claimed on the final day.
    proofFilter.submittedAt = { $gte: window.start, $lte: window.end };
  }

  const [totals, byStatus, pendingProofs] = await Promise.all([
    collectionTotals(filter),
    countInvoicesByField(filter, "status"),
    PaymentEventModel.countDocuments({ ...proofFilter, ...PENDING_CLAIM_FILTER }),
  ]);

  return {
    report: {
      byStatus,
      pendingProofs,
      totalDue: totals.dueAmount,
      totalPaid: totals.paidAmount,
    },
  };
}

export async function getHostelAdminComplaintsReport(
  query: ReportQuery,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const scoped = hostelFilter(principal, query.hostelId);

  const [byStatus, byCategory, total] = await Promise.all([
    countByField(ComplaintModel, scoped, "status"),
    countByField(ComplaintModel, scoped, "category"),
    ComplaintModel.countDocuments(scoped),
  ]);

  return {
    report: {
      byCategory,
      byStatus,
      total,
    },
  };
}

const OVERVIEW_MONTHS = 6;
const RECENT_PAYMENT_ROWS = 12;

type ResidentNameRecord = {
  _id: Types.ObjectId;
  firstName?: string;
  lastName?: string;
  roomType?: string;
};

export function collectionRate(due: number, paid: number) {
  return due > 0 ? Number(((paid / due) * 100).toFixed(1)) : 0;
}

/**
 * Last `OVERVIEW_MONTHS` month keys ending at `month` (or the current month).
 *
 * These keys are matched against `Invoice.period`, so they are Bikram Sambat
 * months or they match nothing. Built by stepping Gregorian months, which is
 * what this did, the overview's payment chart drew six months of zeroes over a
 * hostel that had billed every one of them.
 *
 * A pre-cutover Gregorian anchor is honoured as itself rather than converted:
 * `addBsMonths` is plain month arithmetic on a `YYYY-MM` key and carries a year
 * the same way in either calendar, so asking for September 2026 still walks back
 * through August and July. See `isBsPeriod` for why the two never collide.
 */
function recentMonthKeys(month?: string) {
  const anchor = month ?? hostelPeriodOf(new Date());

  return Array.from({ length: OVERVIEW_MONTHS }, (_, offset) =>
    addBsMonths(anchor, -(OVERVIEW_MONTHS - 1 - offset)),
  );
}

/**
 * Month-by-month roll-up straight off the Payment ledger — the same records the
 * Payments screen writes, so the report never drifts from what admins recorded.
 */
async function monthlyPaymentSeries(scope: LedgerScope, months: string[]) {
  const points = await monthlySeries(scope, months);

  return points.map((point) => ({
    collectionRate: collectionRate(point.dueAmount, point.paidAmount),
    due: point.dueAmount,
    month: point.period,
    outstanding: Math.max(point.dueAmount - point.paidAmount, 0),
    paid: point.paidAmount,
    residents: point.residentCount,
  }));
}

async function averageResolutionDays(scoped: Record<string, unknown>) {
  const [row] = await ComplaintModel.aggregate<{ averageMs: number }>([
    { $match: { ...scoped, resolvedAt: { $ne: null } } },
    {
      $group: {
        _id: null,
        averageMs: { $avg: { $subtract: ["$resolvedAt", "$createdAt"] } },
      },
    },
  ]);

  return row?.averageMs ? Number((row.averageMs / DAY_MS).toFixed(1)) : null;
}

async function foodRatingSummary(scoped: Record<string, unknown>) {
  const [row] = await FoodFeedbackModel.aggregate<{
    averageRating: number;
    total: number;
  }>([
    { $match: scoped },
    { $group: { _id: null, averageRating: { $avg: "$rating" }, total: { $sum: 1 } } },
  ]);

  return {
    averageRating: row?.averageRating ? Number(row.averageRating.toFixed(2)) : null,
    total: row?.total ?? 0,
  };
}

async function referralRewardTotals(scoped: Record<string, unknown>) {
  const [row] = await ReferralRewardModel.aggregate<{
    approved: number;
    paid: number;
    total: number;
  }>([
    { $match: scoped },
    {
      $group: {
        _id: null,
        approved: {
          $sum: { $cond: [{ $eq: ["$status", "APPROVED"] }, "$amount", 0] },
        },
        paid: { $sum: { $cond: [{ $eq: ["$status", "PAID"] }, "$amount", 0] } },
        total: { $sum: "$amount" },
      },
    },
  ]);

  return {
    approvedAmount: row?.approved ?? 0,
    paidAmount: row?.paid ?? 0,
    totalAmount: row?.total ?? 0,
  };
}

/**
 * Everything the hostel Reports screen shows, in one round trip. Each section
 * is aggregated from the collection that owns it, so the figures are the live
 * operational records rather than a separately maintained metrics store.
 */
export async function getHostelAdminReportsOverview(
  query: ReportQuery,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const now = new Date();
  const scoped = hostelFilter(principal, query.hostelId);
  const notDeleted = { ...scoped, isDeleted: false };
  const scopedHostelIds =
    scoped.hostelId instanceof Types.ObjectId ? [scoped.hostelId] : scoped.hostelId.$in;
  const months = recentMonthKeys(query.month);
  const selectedMonth = query.month ?? months[months.length - 1];
  const monthPaymentFilter = ledgerScopeFrom(scoped, { period: selectedMonth });

  const [
    hostels,
    residentsByStatus,
    residents,
    vacantBeds,
    paymentTotals,
    monthTotals,
    paymentsByStatus,
    paymentsByMethod,
    pendingProofs,
    monthly,
    recentPayments,
    complaintsByStatus,
    complaintsByCategory,
    complaintsTotal,
    slaBreached,
    resolutionDays,
    maintenanceByStatus,
    maintenanceByCategory,
    maintenanceTotal,
    maintenanceCompleted,
    food,
    nightStatus,
    inquiriesByStatus,
    inquiriesTotal,
    referralsByStatus,
    referralsTotal,
    rewards,
    viewStats,
  ] = await Promise.all([
    HostelModel.find({ _id: { $in: scopedHostelIds }, isDeleted: false })
      .select("roomConfigurations")
      .lean<
        Array<{ roomConfigurations?: Array<{ bedsPerRoom?: number; rooms?: number }> }>
      >(),
    countByField(ResidentModel, notDeleted, "status"),
    ResidentModel.countDocuments(notDeleted),
    countVacantBeds(scopedHostelIds),
    collectionTotals(ledgerScopeFrom(scoped)),
    collectionTotals(monthPaymentFilter),
    countInvoicesByField(ledgerScopeFrom(scoped), "status"),
    countInvoicesByField(ledgerScopeFrom(scoped), "method"),
    PaymentEventModel.countDocuments({ ...scoped, ...PENDING_CLAIM_FILTER }),
    monthlyPaymentSeries(ledgerScopeFrom(scoped), months),
    listRecentInvoices(ledgerScopeFrom(scoped), RECENT_PAYMENT_ROWS),
    countByField(ComplaintModel, scoped, "status"),
    countByField(ComplaintModel, scoped, "category"),
    ComplaintModel.countDocuments(scoped),
    ComplaintModel.countDocuments({
      ...scoped,
      slaDueAt: { $lt: now },
      status: { $in: ["PENDING", "IN_PROGRESS"] },
    }),
    averageResolutionDays(scoped),
    countByField(MaintenanceRequestModel, notDeleted, "status"),
    countByField(MaintenanceRequestModel, notDeleted, "category"),
    MaintenanceRequestModel.countDocuments(notDeleted),
    MaintenanceRequestModel.countDocuments({ ...notDeleted, status: "COMPLETED" }),
    foodRatingSummary(scoped),
    countByField(NightStatusModel, scoped, "status"),
    countByField(InquiryModel, notDeleted, "status"),
    InquiryModel.countDocuments(notDeleted),
    countByField(ReferralModel, notDeleted, "status"),
    ReferralModel.countDocuments(notDeleted),
    referralRewardTotals(scoped),
    getHostelViewStats(scopedHostelIds),
  ]);

  const residentIds = [
    ...new Set(recentPayments.map((payment) => payment.residentId.toString())),
  ];
  const residentRows = await ResidentModel.find({ _id: { $in: residentIds } })
    .select("firstName lastName roomType")
    .lean<ResidentNameRecord[]>();
  const residentById = new Map(
    residentRows.map((resident) => [
      resident._id.toString(),
      {
        name: `${resident.firstName ?? ""} ${resident.lastName ?? ""}`.trim() || "—",
        roomType: resident.roomType ?? "—",
      },
    ]),
  );

  const totalBeds = hostels.reduce(
    (total, hostel) =>
      total +
      (hostel.roomConfigurations ?? []).reduce(
        (sum, config) => sum + (config.bedsPerRoom ?? 0) * (config.rooms ?? 0),
        0,
      ),
    0,
  );
  const occupiedBeds = Math.max(totalBeds - vacantBeds, 0);
  const converted = inquiriesByStatus.CONVERTED ?? 0;
  const joinedReferrals =
    (referralsByStatus.JOINED ?? 0) + (referralsByStatus.REWARDED ?? 0);

  return {
    overview: {
      complaints: {
        byCategory: complaintsByCategory,
        byStatus: complaintsByStatus,
        averageResolutionDays: resolutionDays,
        open: (complaintsByStatus.PENDING ?? 0) + (complaintsByStatus.IN_PROGRESS ?? 0),
        resolved: complaintsByStatus.RESOLVED ?? 0,
        slaBreached,
        total: complaintsTotal,
      },
      food: {
        averageRating: food.averageRating,
        feedbackCount: food.total,
      },
      generatedAt: now.toISOString(),
      inquiries: {
        byStatus: inquiriesByStatus,
        conversionRate: collectionRate(inquiriesTotal, converted),
        converted,
        total: inquiriesTotal,
      },
      maintenance: {
        byCategory: maintenanceByCategory,
        byStatus: maintenanceByStatus,
        completed: maintenanceCompleted,
        open: maintenanceTotal - maintenanceCompleted,
        total: maintenanceTotal,
      },
      months,
      nightStatus,
      occupancy: {
        byStatus: residentsByStatus,
        occupancyRate: collectionRate(totalBeds, occupiedBeds),
        occupiedBeds,
        residents,
        totalBeds,
        vacantBeds,
      },
      payments: {
        byMethod: paymentsByMethod,
        byStatus: paymentsByStatus,
        collectionRate: collectionRate(paymentTotals.dueAmount, paymentTotals.paidAmount),
        monthly,
        outstanding: Math.max(paymentTotals.dueAmount - paymentTotals.paidAmount, 0),
        pendingProofs,
        recent: recentPayments.map((payment) => ({
          dueAmount: payment.dueAmount,
          dueDate: payment.dueDate?.toISOString() ?? null,
          id: payment.id,
          method: payment.method ?? "",
          month: payment.period,
          paidAmount: payment.paidAmount,
          paidDate: payment.paidDate?.toISOString() ?? null,
          residentName: residentById.get(payment.residentId)?.name ?? "—",
          roomType: residentById.get(payment.residentId)?.roomType ?? "—",
          status: payment.status,
        })),
        selectedMonth: {
          collectionRate: collectionRate(monthTotals.dueAmount, monthTotals.paidAmount),
          month: selectedMonth,
          outstanding: Math.max(monthTotals.dueAmount - monthTotals.paidAmount, 0),
          totalDue: monthTotals.dueAmount,
          totalPaid: monthTotals.paidAmount,
        },
        totalDue: paymentTotals.dueAmount,
        totalPaid: paymentTotals.paidAmount,
      },
      referrals: {
        byStatus: referralsByStatus,
        joined: joinedReferrals,
        rewardApprovedAmount: rewards.approvedAmount,
        rewardPaidAmount: rewards.paidAmount,
        rewardTotalAmount: rewards.totalAmount,
        total: referralsTotal,
      },
      visibility: {
        publicViewsLast30Days: viewStats.publicViewsLast30Days,
        totalPublicViews: viewStats.totalPublicViews,
        uniquePublicVisitors: viewStats.uniquePublicVisitors,
      },
    },
  };
}

export async function getHostelAdminMaintenanceReport(
  query: ReportQuery,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const scoped = {
    ...hostelFilter(principal, query.hostelId),
    isDeleted: false,
  };

  const [byStatus, byCategory, total, completed] = await Promise.all([
    countByField(MaintenanceRequestModel, scoped, "status"),
    countByField(MaintenanceRequestModel, scoped, "category"),
    MaintenanceRequestModel.countDocuments(scoped),
    MaintenanceRequestModel.countDocuments({ ...scoped, status: "COMPLETED" }),
  ]);

  return {
    report: {
      byCategory,
      byStatus,
      completed,
      open: total - completed,
      total,
    },
  };
}
