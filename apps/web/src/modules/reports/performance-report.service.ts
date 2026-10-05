import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { Role } from "@/lib/roles";
import { getMonthMoneyOut } from "@/modules/finance/expenses/expense.service";
import { addBsMonths, bsPeriodBounds, hostelPeriodOf, isBsPeriod } from "@/lib/hostel-day";
import { ComplaintModel } from "@hostel/db/models/Complaint";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelPageViewModel } from "@hostel/db/models/HostelPageView";
import { InquiryModel } from "@hostel/db/models/Inquiry";
import { MaintenanceRequestModel } from "@hostel/db/models/MaintenanceRequest";
import { MoveOutChecklistModel } from "@hostel/db/models/MoveOutChecklist";
import { NightStatusModel } from "@hostel/db/models/NightStatus";
import { PaymentEventModel } from "@hostel/db/models/PaymentEvent";
import { RatingReviewModel } from "@hostel/db/models/RatingReview";
import { ResidentModel } from "@hostel/db/models/Resident";
import { nightKey } from "@hostel/shared/night/night-window";
import {
  collectionTotals,
  countInvoicesByField,
  monthlySeries,
} from "@/modules/finance/ledger-read.service";
import { countListingAppearances } from "@/modules/hostels/hostel-impression.service";
import {
  PENDING_CLAIM_FILTER,
  collectionRate,
  hostelFilter,
  ledgerScopeFrom,
} from "@/modules/reports/report.service";
import type { performanceReportQuerySchema } from "@/modules/reports/report.validation";

/**
 * The hostel's month on one page — what the Reports screen shows and what the
 * downloadable PDF prints.
 *
 * ## One payload for both
 *
 * The screen and the PDF are built from this object and nothing else. A report
 * an owner downloads that disagrees with the screen they pressed Download on is
 * the one mistake a report cannot make, and two readers aggregating separately
 * is how it would happen.
 *
 * ## A month, or right now
 *
 * Everything with a date is counted inside the selected **BS month** — billed,
 * collected, moved in, page views. Three things have no history and are
 * reported as they stand at `generatedAt` instead: who is living here, who is
 * in tonight, and how many beds are free. The payload keeps those under
 * `residents.now` / `beds` so neither reader can present them as the month's.
 *
 * ## Move-outs have two doors
 *
 * The move-out checklist stamps `completedAt`, and is the normal way out. The
 * status dropdown sets `MOVED_OUT` directly and stamps nothing but `updatedAt`.
 * Both are counted; a resident who has a completed checklist is only ever
 * counted by it, so a later edit to their row cannot count them twice.
 */

type PerformanceQuery = z.infer<typeof performanceReportQuerySchema>;

/** How many months the collection trend runs back, including the selected one. */
const TREND_MONTHS = 6;
/** How far back the month picker offers. */
const PICKER_MONTHS = 12;

const LIVE_STATUSES = ["ACTIVE", "PENDING", "SUSPENDED"] as const;

export type PerformanceReport = Awaited<ReturnType<typeof getHostelPerformanceReport>>;

/** `{ current, previous, change }` — change is a percent, `null` with nothing to compare. */
function compare(current: number, previous: number) {
  return {
    change: previous > 0 ? Math.round(((current - previous) / previous) * 100) : null,
    current,
    previous,
  };
}

function windowFor(month: string, now: Date) {
  const { end, start } = bsPeriodBounds(month);

  // The current month is reported "so far" — its end is now, not a day that
  // has not happened.
  return { end: end > now ? now : end, fullEnd: end, start };
}

async function sumOverWindow(
  hostelIds: Types.ObjectId[],
  from: Date,
  to: Date,
) {
  const [row] = await HostelPageViewModel.aggregate<{ views: number; visitors: number }>([
    { $match: { createdAt: { $gte: from, $lte: to }, hostelId: { $in: hostelIds } } },
    { $group: { _id: "$visitorKey", views: { $sum: 1 } } },
    { $group: { _id: null, views: { $sum: "$views" }, visitors: { $sum: 1 } } },
  ]);

  return { views: row?.views ?? 0, visitors: row?.visitors ?? 0 };
}

async function countMoveOuts(
  scoped: Record<string, unknown>,
  from: Date,
  to: Date,
) {
  const withChecklist = (await MoveOutChecklistModel.distinct("residentId", {
    ...scoped,
    completedAt: { $ne: null },
  })) as Types.ObjectId[];

  const [byChecklist, byStatus] = await Promise.all([
    MoveOutChecklistModel.countDocuments({
      ...scoped,
      completedAt: { $gte: from, $lte: to },
    }),
    ResidentModel.countDocuments({
      ...scoped,
      _id: { $nin: withChecklist },
      isDeleted: false,
      status: "MOVED_OUT",
      updatedAt: { $gte: from, $lte: to },
    }),
  ]);

  return byChecklist + byStatus;
}

export async function getHostelPerformanceReport(
  query: PerformanceQuery,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const now = new Date();
  const currentMonth = hostelPeriodOf(now);
  // A future month has nothing to report, and a key the calendar cannot bound
  // would throw below — both fall back to this month rather than erroring.
  const month =
    query.month && isBsPeriod(query.month) && query.month <= currentMonth
      ? query.month
      : currentMonth;
  const previousMonth = addBsMonths(month, -1);

  const scoped = hostelFilter(principal, query.hostelId);
  const notDeleted = { ...scoped, isDeleted: false };
  const hostelIds =
    scoped.hostelId instanceof Types.ObjectId ? [scoped.hostelId] : scoped.hostelId.$in;

  const window = windowFor(month, now);
  const previous = windowFor(previousMonth, now);
  const trendMonths = Array.from({ length: TREND_MONTHS }, (_, index) =>
    addBsMonths(month, index - (TREND_MONTHS - 1)),
  );
  const inWindow = { $gte: window.start, $lte: window.end };
  const inPrevious = { $gte: previous.start, $lte: previous.fullEnd };
  const tonight = nightKey(now);

  const [
    hostels,
    liveResidents,
    monthTotals,
    allTimeTotals,
    trend,
    methods,
    pendingProofs,
    movedIn,
    movedOut,
    views,
    previousViews,
    appearances,
    previousAppearances,
    inquiries,
    previousInquiries,
    converted,
    rating,
    newReviews,
    complaintsRaised,
    complaintsResolved,
    complaintsOpen,
    complaintsPastSla,
    repairsRaised,
    repairsCompleted,
    repairsOpen,
  ] = await Promise.all([
    HostelModel.find({ _id: { $in: hostelIds }, isDeleted: false })
      .select("name roomConfigurations")
      .lean<
        Array<{
          name?: string;
          roomConfigurations?: Array<{
            bedsPerRoom?: number;
            rooms?: number;
            vacantBeds?: number;
          }>;
        }>
      >(),
    ResidentModel.find({ ...notDeleted, status: { $in: LIVE_STATUSES } })
      .select("_id status")
      .lean<Array<{ _id: Types.ObjectId; status: (typeof LIVE_STATUSES)[number] }>>(),
    collectionTotals(ledgerScopeFrom(scoped, { period: month })),
    collectionTotals(ledgerScopeFrom(scoped)),
    monthlySeries(ledgerScopeFrom(scoped), trendMonths),
    countInvoicesByField(ledgerScopeFrom(scoped, { period: month }), "method"),
    PaymentEventModel.countDocuments({ ...scoped, ...PENDING_CLAIM_FILTER }),
    ResidentModel.countDocuments({ ...notDeleted, moveInDate: inWindow }),
    countMoveOuts(scoped, window.start, window.end),
    sumOverWindow(hostelIds, window.start, window.end),
    sumOverWindow(hostelIds, previous.start, previous.fullEnd),
    countListingAppearances(hostelIds, window.start, window.end),
    countListingAppearances(hostelIds, previous.start, previous.fullEnd),
    InquiryModel.countDocuments({ ...notDeleted, createdAt: inWindow }),
    InquiryModel.countDocuments({ ...notDeleted, createdAt: inPrevious }),
    InquiryModel.countDocuments({ ...notDeleted, createdAt: inWindow, status: "CONVERTED" }),
    RatingReviewModel.aggregate<{ average: number | null; total: number }>([
      { $match: { hostelId: { $in: hostelIds }, status: "VISIBLE" } },
      { $group: { _id: null, average: { $avg: "$overallRating" }, total: { $sum: 1 } } },
    ]),
    RatingReviewModel.countDocuments({
      createdAt: inWindow,
      hostelId: { $in: hostelIds },
      status: "VISIBLE",
    }),
    ComplaintModel.countDocuments({ ...scoped, createdAt: inWindow }),
    ComplaintModel.countDocuments({ ...scoped, resolvedAt: inWindow }),
    ComplaintModel.countDocuments({ ...scoped, status: { $in: ["PENDING", "IN_PROGRESS"] } }),
    ComplaintModel.countDocuments({
      ...scoped,
      slaDueAt: { $lt: now },
      status: { $in: ["PENDING", "IN_PROGRESS"] },
    }),
    MaintenanceRequestModel.countDocuments({ ...notDeleted, createdAt: inWindow }),
    MaintenanceRequestModel.countDocuments({ ...notDeleted, completedAt: inWindow }),
    MaintenanceRequestModel.countDocuments({
      ...notDeleted,
      status: { $nin: ["COMPLETED", "CANCELLED"] },
    }),
  ]);

  const nightRows = await NightStatusModel.find({
    night: tonight,
    residentId: { $in: liveResidents.map((resident) => resident._id) },
  })
    .select("status")
    .lean<Array<{ status: string }>>();

  const inside = nightRows.filter((row) => row.status === "INSIDE_HOSTEL").length;
  const outside = nightRows.filter((row) => row.status === "OUTSIDE_HOSTEL").length;

  const beds = hostels.reduce(
    (sum, hostel) => {
      for (const config of hostel.roomConfigurations ?? []) {
        sum.total += (config.bedsPerRoom ?? 0) * (config.rooms ?? 0);
        sum.vacant += config.vacantBeds ?? 0;
      }

      return sum;
    },
    { total: 0, vacant: 0 },
  );
  const occupiedBeds = Math.max(beds.total - beds.vacant, 0);

  const previousPoint = trend[trend.length - 2];
  const byStatus = (status: (typeof LIVE_STATUSES)[number]) =>
    liveResidents.filter((resident) => resident.status === status).length;

  // Money out is the owner's: a warden reading this report never sees the hostel's spending.
  const moneyOut =
    principal.role === Role.HOSTEL_ADMIN && hostelIds.length === 1
      ? await getMonthMoneyOut(hostelIds[0]!, month, principal.userId)
      : null;

  return {
    moneyOut,
    generatedAt: now.toISOString(),
    hostelName:
      hostels.length === 1 ? (hostels[0].name ?? "") : `${hostels.length} hostels`,
    period: {
      end: window.end.toISOString(),
      isCurrent: month === currentMonth,
      month,
      /** Newest first — what the picker offers. */
      months: Array.from({ length: PICKER_MONTHS }, (_, index) =>
        addBsMonths(currentMonth, -index),
      ),
      previousMonth,
      start: window.start.toISOString(),
    },
    finance: {
      billed: monthTotals.dueAmount,
      collected: monthTotals.paidAmount,
      /** `null` when nothing was billed — there is no rate to have. */
      collectionRate:
        monthTotals.dueAmount > 0
          ? collectionRate(monthTotals.dueAmount, monthTotals.paidAmount)
          : null,
      outstanding: Math.max(monthTotals.dueAmount - monthTotals.paidAmount, 0),
      outstandingAllTime: Math.max(allTimeTotals.dueAmount - allTimeTotals.paidAmount, 0),
      pendingProofs,
      previous: {
        billed: previousPoint?.dueAmount ?? 0,
        collected: previousPoint?.paidAmount ?? 0,
        collectionRate:
          previousPoint && previousPoint.dueAmount > 0
            ? collectionRate(previousPoint.dueAmount, previousPoint.paidAmount)
            : null,
      },
      methods: Object.entries(methods)
        .filter(([method, count]) => count > 0 && method && method !== "UNKNOWN")
        .map(([method, count]) => ({ count, method }))
        .sort((a, b) => b.count - a.count),
      trend: trend.map((point) => ({
        billed: point.dueAmount,
        collected: point.paidAmount,
        collectionRate:
          point.dueAmount > 0 ? collectionRate(point.dueAmount, point.paidAmount) : null,
        month: point.period,
      })),
    },
    residents: {
      movedIn,
      movedOut,
      now: {
        active: byStatus("ACTIVE"),
        pending: byStatus("PENDING"),
        suspended: byStatus("SUSPENDED"),
        total: liveResidents.length,
      },
      tonight: {
        inside,
        night: tonight,
        /** Everyone living here who has not said in or out for tonight. */
        notAnswered: Math.max(liveResidents.length - inside - outside, 0),
        outside,
      },
    },
    beds: {
      occupancyRate: beds.total > 0 ? collectionRate(beds.total, occupiedBeds) : null,
      occupied: occupiedBeds,
      total: beds.total,
      vacant: beds.vacant,
    },
    listing: {
      appearances: compare(appearances, previousAppearances),
      inquiries: compare(inquiries, previousInquiries),
      inquiriesConverted: converted,
      rating: {
        average: rating[0]?.average ? Number(rating[0].average.toFixed(1)) : null,
        newThisMonth: newReviews,
        total: rating[0]?.total ?? 0,
      },
      views: compare(views.views, previousViews.views),
      visitors: compare(views.visitors, previousViews.visitors),
    },
    operations: {
      complaints: {
        open: complaintsOpen,
        pastSla: complaintsPastSla,
        raised: complaintsRaised,
        resolved: complaintsResolved,
      },
      repairs: {
        completed: repairsCompleted,
        open: repairsOpen,
        raised: repairsRaised,
      },
    },
  };
}
