/**
 * The hostel dashboard's money cards.
 *
 * Both figures on them were wrong in the same two ways, and neither was visible
 * from the code: the scope carried a hostel and nothing else, so a card labelled
 * "Monthly Dues" summed every invoice the hostel had ever issued, and it counted
 * invoices belonging to soft-deleted residents — the same defect that made the
 * payments matrix and the month picker disagree with each other.
 *
 * These assert the *filter*, not the arithmetic. `collectionTotals` is already
 * tested; what was never tested is what it gets asked, which is where both bugs
 * lived.
 */
import { Types } from "mongoose";

import { bsPeriodOf } from "@hostel/shared/calendar/bs";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiPrincipal } from "@/lib/api-auth";
import { Role } from "@/lib/roles";

const mocks = vi.hoisted(() => ({
  collectionTotals: vi.fn(),
  countableResidentIds: vi.fn(),
  countByFieldAggregate: vi.fn(),
  eventCount: vi.fn(),
  genericCount: vi.fn(),
  hostelFind: vi.fn(),
  residentCount: vi.fn(),
  statementNudge: vi.fn(),
  viewStats: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/lib/tenant", () => ({ assertHostelAccess: vi.fn() }));

vi.mock("@/modules/finance/ledger-read.service", () => ({
  collectionTotals: mocks.collectionTotals,
  countInvoicesByField: vi.fn().mockResolvedValue({}),
  countInvoicesByStatus: vi.fn().mockResolvedValue({}),
  latestInvoicePerResident: vi.fn().mockResolvedValue(new Map()),
  listRecentInvoices: vi.fn().mockResolvedValue([]),
  outstandingForResident: vi.fn().mockResolvedValue(0),
}));

vi.mock("@/modules/finance/resident-scope", () => ({
  countableResidentIds: mocks.countableResidentIds,
}));

vi.mock("@/modules/finance/statements/statement-nudge", () => ({
  getStatementNudge: mocks.statementNudge,
}));

vi.mock("@/modules/hostels/hostel-view.service", () => ({
  getHostelViewStats: mocks.viewStats,
}));

vi.mock("@hostel/db/models/HostelPageView", () => ({
  HostelPageViewModel: { countDocuments: vi.fn().mockResolvedValue(0) },
}));
vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: { find: mocks.hostelFind },
}));

vi.mock("@hostel/db/models/PaymentEvent", () => ({
  PaymentEventModel: { countDocuments: mocks.eventCount },
}));

vi.mock("@hostel/db/models/Resident", () => ({
  ResidentModel: { countDocuments: mocks.residentCount },
}));

// `vi.mock` is hoisted, so each of these has to be a literal top-level call —
// a loop reads better and silently registers nothing.
vi.mock("@hostel/db/models/Complaint", () => ({
  ComplaintModel: {
    aggregate: mocks.countByFieldAggregate,
    countDocuments: mocks.genericCount,
  },
}));

vi.mock("@hostel/db/models/FoodFeedback", () => ({
  FoodFeedbackModel: {
    aggregate: mocks.countByFieldAggregate,
    countDocuments: mocks.genericCount,
  },
}));

vi.mock("@hostel/db/models/Inquiry", () => ({
  InquiryModel: {
    aggregate: mocks.countByFieldAggregate,
    countDocuments: mocks.genericCount,
  },
}));

vi.mock("@hostel/db/models/ListingFlag", () => ({
  ListingFlagModel: {
    aggregate: mocks.countByFieldAggregate,
    countDocuments: mocks.genericCount,
  },
}));

vi.mock("@hostel/db/models/MaintenanceRequest", () => ({
  MaintenanceRequestModel: {
    aggregate: mocks.countByFieldAggregate,
    countDocuments: mocks.genericCount,
  },
}));

vi.mock("@hostel/db/models/RatingReview", () => ({
  RatingReviewModel: {
    aggregate: mocks.countByFieldAggregate,
    countDocuments: mocks.genericCount,
  },
}));

vi.mock("@hostel/db/models/Referral", () => ({
  ReferralModel: {
    aggregate: mocks.countByFieldAggregate,
    countDocuments: mocks.genericCount,
  },
}));

vi.mock("@hostel/db/models/ReferralReward", () => ({
  ReferralRewardModel: {
    aggregate: mocks.countByFieldAggregate,
    countDocuments: mocks.genericCount,
  },
}));

vi.mock("@hostel/db/models/ServiceProvider", () => ({
  ServiceProviderModel: {
    aggregate: mocks.countByFieldAggregate,
    countDocuments: mocks.genericCount,
  },
}));

vi.mock("@hostel/db/models/NightStatus", () => ({
  NightStatusModel: { aggregate: mocks.countByFieldAggregate },
}));

const { getHostelAdminDashboardReport, resetHostelAdminDashboardCache } = await import(
  "@/modules/reports/report.service",
);

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const residentA = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0c1");
const residentB = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0c2");

const principal = {
  hostelIds: [hostelId.toString()],
  role: Role.HOSTEL_ADMIN,
  userId: new Types.ObjectId().toString(),
} as ApiPrincipal;

/**
 * "This month" the way the product means it — the Bikram Sambat one.
 *
 * Re-derived from the shared calendar rather than assembled from `getMonth()`.
 * A local copy of the arithmetic would have been Gregorian, which is exactly the
 * disagreement between "the month the card totals" and "the month the invoices
 * are keyed by" that this test exists to catch.
 */
function currentPeriod() {
  return bsPeriodOf(new Date());
}

beforeEach(() => {
  vi.clearAllMocks();
  // The report is memoised per hostel scope; every case here asks the same
  // scope, so without this the second one reads the first one's answer.
  resetHostelAdminDashboardCache();
  mocks.collectionTotals.mockResolvedValue({ dueAmount: 0, paidAmount: 0 });
  mocks.countableResidentIds.mockResolvedValue([residentA, residentB]);
  mocks.countByFieldAggregate.mockReturnValue({ exec: () => Promise.resolve([]) });
  mocks.eventCount.mockResolvedValue(0);
  mocks.genericCount.mockResolvedValue(0);
  mocks.hostelFind.mockReturnValue({
    lean: () => Promise.resolve([]),
    select: vi.fn().mockReturnThis(),
  });
  mocks.residentCount.mockResolvedValue(2);
  mocks.statementNudge.mockResolvedValue(null);
  mocks.viewStats.mockResolvedValue({
    publicViewsLast30Days: 0,
    totalPublicViews: 0,
    uniquePublicVisitors: 0,
  });
});

describe("the dashboard money cards", () => {
  it('scopes "dues this month" to this month', async () => {
    // It summed every invoice ever issued, so the card grew forever and agreed
    // with no figure on the payments screen.
    await getHostelAdminDashboardReport({}, principal);

    expect(mocks.collectionTotals).toHaveBeenCalledWith(
      expect.objectContaining({ period: currentPeriod() }),
    );
  });

  it("counts only residents the hostel can still act on", async () => {
    await getHostelAdminDashboardReport({}, principal);

    expect(mocks.collectionTotals).toHaveBeenCalledWith(
      expect.objectContaining({ residentIds: [residentA, residentB] }),
    );
  });

  it("scopes the pending-proof count the same way", async () => {
    await getHostelAdminDashboardReport({}, principal);

    expect(mocks.eventCount).toHaveBeenCalledWith(
      expect.objectContaining({
        residentId: { $in: [residentA, residentB] },
        source: "RESIDENT_CLAIM",
        status: "PENDING",
      }),
    );
  });

  it("counts residents with $ne:true, matching every other resident read", async () => {
    // `isDeleted: false` misses a row written without the field; `$ne: true`
    // does not. Two forms of the same question is how the dashboard and the
    // payments screen disagreed on how many residents exist.
    await getHostelAdminDashboardReport({}, principal);

    expect(mocks.residentCount).toHaveBeenCalledWith(
      expect.objectContaining({ isDeleted: { $ne: true } }),
    );
  });
});
