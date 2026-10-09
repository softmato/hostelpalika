import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_LIFETIME } from "@/modules/platform-config/lifetime.defaults";
import { lifetimeSchema } from "@/modules/platform-config/site-config.validation";
import {
  formatLifetimeDay,
  lifetimeEndsAt,
  lifetimeMonthsEquivalent,
  lifetimeOfferFor,
  lifetimeSeatsLeft,
  lifetimeTotalSeats,
  lifetimeWindow,
  nepalDay,
} from "@hostel/shared/plans/lifetime";

/**
 * The lifetime deal: one payment, a plan for life, to a fixed number of
 * hostels inside a dated window — and none of it touching the regular plans.
 *
 * Pinned here: the window is Nepal calendar days, inclusive; seats are counted,
 * never below zero; a lifetime choice carries no free months; settling it in
 * full takes the seat and runs the plan for life; nothing renews it afterwards.
 */

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  auditCreate: vi.fn(),
  availability: vi.fn(),
  counterFindOneAndUpdate: vi.fn(),
  getOperationsConfig: vi.fn(),
  getSiteConfigSection: vi.fn(),
  hostelFindById: vi.fn(),
  hostelUpdateOne: vi.fn(),
  invoiceCreate: vi.fn(),
  invoiceExists: vi.fn(),
  invoiceFindById: vi.fn(),
  invoiceFindOne: vi.fn(),
  invoiceUpdateOne: vi.fn(),
  issueInvoiceDocument: vi.fn(),
  onInvoiceIssued: vi.fn(),
  onPaymentSettled: vi.fn(),
  paymentFind: vi.fn(),
  paymentFindById: vi.fn(),
  paymentFindOneAndUpdate: vi.fn(),
  paymentUpdateOne: vi.fn(),
  subscriptionCreate: vi.fn(),
  subscriptionFindById: vi.fn(),
  subscriptionFindOne: vi.fn(),
  subscriptionUpdateOne: vi.fn(),
  userFindById: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/modules/hostel-referrals/hostel-referral.service", () => ({
  settleHostelReferrals: vi.fn(),
}));
vi.mock("@/modules/hostels/hostel-suspension", () => ({ liftHostelSuspension: vi.fn() }));
vi.mock("@/modules/hostels/hostel.service", () => ({ grantHostelOwnerAccess: vi.fn() }));
vi.mock("@hostel/db/models/AuditLog", () => ({ AuditLogModel: { create: mocks.auditCreate } }));
vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: { findById: mocks.hostelFindById, updateOne: mocks.hostelUpdateOne },
}));
vi.mock("@hostel/db/models/User", () => ({ UserModel: { findById: mocks.userFindById } }));
vi.mock("@hostel/db/models/HostelSubscription", () => ({
  HostelSubscriptionModel: {
    create: mocks.subscriptionCreate,
    findById: mocks.subscriptionFindById,
    findOne: mocks.subscriptionFindOne,
    updateOne: mocks.subscriptionUpdateOne,
  },
}));
vi.mock("@hostel/db/models/SubscriptionInvoice", () => ({
  SubscriptionInvoiceModel: {
    create: mocks.invoiceCreate,
    exists: mocks.invoiceExists,
    findById: mocks.invoiceFindById,
    findOne: mocks.invoiceFindOne,
    updateOne: mocks.invoiceUpdateOne,
  },
}));
vi.mock("@hostel/db/models/SubscriptionPayment", () => ({
  SubscriptionPaymentModel: {
    aggregate: mocks.aggregate,
    find: mocks.paymentFind,
    findById: mocks.paymentFindById,
    findOneAndUpdate: mocks.paymentFindOneAndUpdate,
    updateOne: mocks.paymentUpdateOne,
  },
}));
vi.mock("@hostel/db/models/ReceiptCounter", () => ({
  ReceiptCounterModel: { findOneAndUpdate: mocks.counterFindOneAndUpdate },
}));
vi.mock("@/modules/platform-config/operations-config", () => ({
  getOperationsConfig: mocks.getOperationsConfig,
}));
vi.mock("@/modules/platform-config/site-config.service", () => ({
  getSiteConfigSection: mocks.getSiteConfigSection,
}));
vi.mock("@/modules/team/team-commission.service", () => ({ creditTeamCommission: vi.fn() }));
vi.mock("@/modules/hostels/hostel-registration.events", () => ({
  onInvoiceIssued: mocks.onInvoiceIssued,
  onPaymentSettled: mocks.onPaymentSettled,
}));
vi.mock("@/modules/billing/billing-gateway", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  issueInvoiceDocument: mocks.issueInvoiceDocument,
}));
vi.mock("@/modules/billing/lifetime", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLifetimeAvailability: mocks.availability,
}));

const { LIFETIME_PERIOD_END, isLifetimePeriodEnd } = await import("./lifetime");
const {
  issueSubscriptionInvoice,
  priceLifetime,
  raiseRenewalInvoice,
  selectPlan,
} = await import("./subscription.service");
const { settlePayment, startFreeMonths } = await import("./subscription-payment.service");

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b1");
const subscriptionId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b2");
const invoiceId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b3");
const paymentId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b4");
const actorId = "64f0f0f0f0f0f0f0f0f0f0b5";

function query<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
  };
}

const catalog = {
  cycleLabels: { annual: "Annual", halfYearly: "6 months", monthly: "Monthly" },
  modules: [],
  plans: [
    {
      annualDiscountPercent: 17,
      ctaHref: "/register-hostel",
      ctaLabel: "Start",
      description: "",
      eventDiscountPercent: 0,
      featured: false,
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
  ],
  services: [],
};

function open(overrides: { left?: number; window?: string } = {}) {
  return {
    endsOn: "2026-11-07",
    offers: [
      {
        left: overrides.left ?? 18,
        monthly: 999,
        planId: "go",
        planName: "Go",
        price: 9_999,
        seats: 18,
        sold: 18 - (overrides.left ?? 18),
      },
    ],
    startsOn: "2026-10-07",
    window: overrides.window ?? "open",
  };
}

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    _id: subscriptionId,
    currency: "NPR",
    cycle: "annual",
    cycleMonths: 12,
    cycleTotal: 9_999,
    freeMonths: 0,
    hostelId,
    lifetime: true,
    planId: "go",
    planName: "Go",
    source: "PUBLIC",
    status: "SELECTED",
    ...overrides,
  };
}

function lifetimeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    _id: invoiceId,
    amount: 9_999,
    cycle: "annual",
    cycleMonths: 12,
    hostelId,
    invoiceNumber: "SUB-0001-F0B1",
    issuedAt: new Date("2026-10-07T06:00:00Z"),
    lifetime: true,
    planId: "go",
    planName: "Go",
    source: "PUBLIC",
    status: "OPEN",
    subscriptionId,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.availability.mockResolvedValue(open());
  mocks.getSiteConfigSection.mockResolvedValue(catalog);
  mocks.getOperationsConfig.mockResolvedValue({ subscriptionDueGraceDays: 3 });
  mocks.counterFindOneAndUpdate.mockReturnValue(query({ sequence: 1 }));
  mocks.subscriptionUpdateOne.mockResolvedValue({});
  mocks.invoiceUpdateOne.mockResolvedValue({});
  mocks.paymentUpdateOne.mockResolvedValue({});
  mocks.paymentFindOneAndUpdate.mockReturnValue(query({ _id: paymentId }));
  mocks.hostelUpdateOne.mockResolvedValue({});
  mocks.auditCreate.mockResolvedValue({});
  mocks.paymentFind.mockReturnValue(query([]));
  mocks.userFindById.mockReturnValue(query({ email: "owner@example.com", name: "Owner" }));
  mocks.aggregate.mockResolvedValue([]);
  mocks.issueInvoiceDocument.mockResolvedValue({
    documentUrl: "https://example.test/doc",
    softmatoInvoiceId: "inv_1",
    softmatoInvoiceNo: "INV-1",
  });
});

describe("the deal's window", () => {
  const deal = { enabled: true, endsOn: "2026-11-07", offers: [], startsOn: "2026-10-07" };

  it("is Nepal calendar days, both ends inclusive", () => {
    // 6 Oct 18:14 UTC is 23:59 on the 6th in Kathmandu; a minute later it is the 7th.
    expect(lifetimeWindow(deal, new Date("2026-10-06T18:14:00Z"))).toBe("upcoming");
    expect(lifetimeWindow(deal, new Date("2026-10-06T18:15:00Z"))).toBe("open");
    // All of the 7th of November in Nepal, and not a minute after it.
    expect(lifetimeWindow(deal, new Date("2026-11-07T18:14:00Z"))).toBe("open");
    expect(lifetimeWindow(deal, new Date("2026-11-07T18:15:00Z"))).toBe("ended");
  });

  it("counts down to the same instant the window turns ended", () => {
    const endsAt = lifetimeEndsAt(deal.endsOn)!;

    expect(new Date(endsAt).toISOString()).toBe("2026-11-07T18:15:00.000Z");
    expect(lifetimeWindow(deal, new Date(endsAt - 1))).toBe("open");
    expect(lifetimeWindow(deal, new Date(endsAt))).toBe("ended");
    expect(lifetimeEndsAt("")).toBeNull();
  });

  it("is off whenever it is switched off, and open-ended without dates", () => {
    expect(lifetimeWindow({ ...deal, enabled: false }, new Date("2026-10-20T00:00:00Z"))).toBe("off");
    expect(lifetimeWindow({ ...deal, endsOn: "", startsOn: "" }, new Date("2040-01-01T00:00:00Z"))).toBe(
      "open",
    );
  });

  it("names today's Nepal day", () => {
    expect(nepalDay(new Date("2026-10-06T18:15:00Z"))).toBe("2026-10-07");
    expect(formatLifetimeDay("2026-11-07")).toBe("7 Nov 2026");
    expect(formatLifetimeDay("nonsense")).toBe("");
  });
});

describe("seats and offers", () => {
  it("counts seats left, never below zero", () => {
    expect(lifetimeSeatsLeft({ seats: 18 }, 5)).toBe(13);
    expect(lifetimeSeatsLeft({ seats: 16 }, 17)).toBe(0);
  });

  it("only sells a tier with a price", () => {
    const deal = {
      enabled: true,
      endsOn: "",
      offers: [
        { planId: "go", price: 9_999, seats: 18 },
        { planId: "pro", price: 0, seats: 16 },
      ],
      startsOn: "",
    };

    expect(lifetimeOfferFor(deal, "go")?.price).toBe(9_999);
    expect(lifetimeOfferFor(deal, "pro")).toBeNull();
    expect(lifetimeTotalSeats(deal)).toBe(18);
  });

  it("compares the price to months of the regular plan", () => {
    expect(lifetimeMonthsEquivalent(9_999, 999)).toBe(10);
    expect(lifetimeMonthsEquivalent(9_999, 0)).toBeNull();
  });
});

describe("the shipped deal", () => {
  it("is the launch offer: 50 seats split 18 / 16 / 16, open for a month from 7 Oct 2026", () => {
    expect(lifetimeSchema.parse(DEFAULT_LIFETIME)).toEqual(DEFAULT_LIFETIME);
    expect(DEFAULT_LIFETIME.enabled).toBe(true);
    expect(DEFAULT_LIFETIME.startsOn).toBe("2026-10-07");
    expect(DEFAULT_LIFETIME.endsOn).toBe("2026-11-07");
    expect(DEFAULT_LIFETIME.offers).toEqual([
      { planId: "go", price: 9_999, seats: 18 },
      { planId: "pro", price: 16_999, seats: 16 },
      { planId: "max", price: 24_999, seats: 16 },
    ]);
    expect(lifetimeTotalSeats(DEFAULT_LIFETIME)).toBe(50);
  });

  it("refuses an end before the start, and two offers on one plan", () => {
    expect(lifetimeSchema.safeParse({ ...DEFAULT_LIFETIME, endsOn: "2026-10-01" }).success).toBe(false);
    expect(
      lifetimeSchema.safeParse({
        ...DEFAULT_LIFETIME,
        offers: [...DEFAULT_LIFETIME.offers, { planId: "go", price: 1, seats: 1 }],
      }).success,
    ).toBe(false);
  });
});

describe("pricing the lifetime deal", () => {
  it("prices it once, with no free months", async () => {
    await expect(priceLifetime("go")).resolves.toMatchObject({
      cycleTotal: 9_999,
      freeMonths: 0,
      lifetime: true,
      planId: "go",
      planName: "Go",
    });
  });

  it("refuses outside its window", async () => {
    mocks.availability.mockResolvedValue(open({ window: "ended" }));
    await expect(priceLifetime("go")).rejects.toMatchObject({ errorCode: "LIFETIME_CLOSED" });

    mocks.availability.mockResolvedValue(open({ window: "upcoming" }));
    await expect(priceLifetime("go")).rejects.toThrow(/not opened yet/);
  });

  it("refuses a sold-out tier — unless the money is already in", async () => {
    mocks.availability.mockResolvedValue(open({ left: 0 }));

    await expect(priceLifetime("go")).rejects.toMatchObject({ errorCode: "LIFETIME_SOLD_OUT" });
    await expect(priceLifetime("go", { gate: false })).resolves.toMatchObject({ cycleTotal: 9_999 });
  });

  it("refuses a tier with no lifetime offer", async () => {
    await expect(priceLifetime("pro")).rejects.toMatchObject({ errorCode: "LIFETIME_NOT_OFFERED" });
  });
});

describe("choosing it", () => {
  it("records the lifetime price and no free months", async () => {
    mocks.subscriptionFindOne.mockReturnValue(
      query(subscription({ lifetime: false, planId: null, status: "PENDING_SELECTION" })),
    );
    mocks.invoiceFindOne.mockReturnValue(query(null));
    mocks.hostelFindById.mockReturnValue(query({ name: "Sunrise", verificationStatus: "PENDING" }));

    await selectPlan(hostelId.toString(), { cycle: "monthly", lifetime: true, planId: "go" }, actorId);

    expect(mocks.subscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: subscriptionId },
      expect.objectContaining({
        $set: expect.objectContaining({
          cycleTotal: 9_999,
          freeMonths: 0,
          lifetime: true,
          planId: "go",
          status: "SELECTED",
        }),
      }),
    );
  });

  it("gives it no free months when the hostel goes live", async () => {
    mocks.subscriptionFindOne.mockReturnValue(query(subscription()));

    await expect(startFreeMonths(hostelId.toString(), actorId)).resolves.toBeNull();
    expect(mocks.subscriptionUpdateOne).not.toHaveBeenCalled();
  });
});

describe("invoicing it", () => {
  it("raises one lifetime invoice, printed as Lifetime with no end date", async () => {
    mocks.subscriptionFindOne.mockReturnValue(query(subscription()));
    mocks.subscriptionFindById.mockReturnValue(query(subscription()));
    mocks.invoiceFindOne.mockReturnValue(query(null));
    mocks.hostelFindById.mockReturnValue(
      query({ name: "Sunrise", status: "APPROVED", verificationStatus: "VERIFIED" }),
    );
    mocks.invoiceCreate.mockImplementation(async (doc: Record<string, unknown>) => ({
      toObject: () => ({ _id: invoiceId, ...doc }),
    }));

    await issueSubscriptionInvoice(hostelId.toString(), actorId);

    expect(mocks.invoiceCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 9_999, lifetime: true, periodEnd: LIFETIME_PERIOD_END }),
    );

    const document = mocks.issueInvoiceDocument.mock.calls[0]?.[0];
    expect(document).toMatchObject({ amount: 9_999, description: "Go — Lifetime" });
    expect(document.serviceEndsAt).toBeUndefined();
    expect(mocks.onInvoiceIssued).toHaveBeenCalledWith(
      expect.objectContaining({ cycleLabel: "Lifetime" }),
    );
  });
});

describe("settling it", () => {
  it("takes the seat, runs the plan for life and publishes — replacing any free months", async () => {
    mocks.paymentFindById.mockReturnValue(
      query({
        _id: paymentId,
        amount: 9_999,
        hostelId,
        invoiceId,
        method: "CASH",
        status: "PENDING",
        subscriptionId,
      }),
    );
    mocks.invoiceFindById.mockReturnValue(query(lifetimeInvoice()));
    mocks.subscriptionFindById.mockReturnValue(
      query({ _id: subscriptionId, planId: "go", source: "PUBLIC" }),
    );
    mocks.subscriptionFindOne.mockReturnValue(query(subscription({ status: "AWAITING_PAYMENT" })));
    mocks.invoiceFindOne.mockReturnValue(query(lifetimeInvoice()));
    mocks.hostelFindById.mockReturnValue(
      query({ name: "Sunrise", status: "APPROVED", verificationStatus: "VERIFIED" }),
    );
    mocks.aggregate.mockResolvedValue([{ total: 9_999 }]);

    await settlePayment(paymentId.toString(), { actorId });

    expect(mocks.subscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: subscriptionId },
      expect.objectContaining({
        $set: expect.objectContaining({
          currentPeriodEnd: LIFETIME_PERIOD_END,
          freeMonths: 0,
          freeUntil: null,
          lifetime: true,
          lifetimeSince: expect.any(Date),
          status: "ACTIVE",
        }),
      }),
    );
    expect(mocks.hostelUpdateOne).toHaveBeenCalledWith(
      { _id: hostelId },
      expect.objectContaining({ $set: expect.objectContaining({ status: "PUBLISHED" }) }),
    );
  });
});

describe("after it is paid", () => {
  it("sells the hostel no more time and no other plan", async () => {
    mocks.subscriptionFindOne.mockReturnValue(
      query(
        subscription({
          currentPeriodEnd: LIFETIME_PERIOD_END,
          lifetimeSince: new Date("2026-10-07T06:00:00Z"),
          status: "ACTIVE",
        }),
      ),
    );

    await expect(
      raiseRenewalInvoice(hostelId.toString(), { cycle: "annual", planId: "go" }, actorId),
    ).rejects.toMatchObject({ errorCode: "LIFETIME_PLAN" });
    await expect(
      selectPlan(hostelId.toString(), { cycle: "annual", planId: "go" }, actorId),
    ).rejects.toMatchObject({ errorCode: "LIFETIME_PLAN" });
    expect(mocks.invoiceCreate).not.toHaveBeenCalled();
  });

  it("keeps its period end past any renewal horizon", () => {
    expect(isLifetimePeriodEnd(LIFETIME_PERIOD_END)).toBe(true);
    expect(isLifetimePeriodEnd(new Date("2030-01-01T00:00:00Z"))).toBe(false);
    expect(LIFETIME_PERIOD_END.getUTCFullYear()).toBe(2099);
  });
});
