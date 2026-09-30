import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The rules money turns on.
 *
 * Not a test of mongoose. Every model here is a stub, and what is pinned is the
 * handful of decisions that decide whether a hostel is published, whether an
 * owner is asked for money, and whether a payment counts:
 *
 * - a plan may be chosen **before** verification, but never invoiced before it;
 * - *Pay now* needs verified **and** chosen — neither alone;
 * - paying in full activates and publishes;
 * - paying part of it publishes **only** a team-filed hostel, and leaves a due;
 * - a pending payment is worth nothing;
 * - settling twice issues one receipt;
 * - a payment belonging to another hostel cannot be settled through yours.
 */

const mocks = vi.hoisted(() => ({
  aggregate: vi.fn(),
  auditCreate: vi.fn(),
  connectToDatabase: vi.fn(),
  counterFindOneAndUpdate: vi.fn(),
  creditTeamCommission: vi.fn(),
  getOperationsConfig: vi.fn(),
  getSiteConfigSection: vi.fn(),
  hostelFindById: vi.fn(),
  hostelUpdateOne: vi.fn(),
  invoiceCreate: vi.fn(),
  invoiceExists: vi.fn(),
  invoiceFindById: vi.fn(),
  invoiceFindOneAndUpdate: vi.fn(),
  documentSequenceFindOneAndUpdate: vi.fn(),
  invoiceFindOne: vi.fn(),
  invoiceUpdateOne: vi.fn(),
  onInvoiceIssued: vi.fn(),
  onPaymentSettled: vi.fn(),
  paymentCreate: vi.fn(),
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

vi.mock("@/lib/db", () => ({ connectToDatabase: mocks.connectToDatabase }));
vi.mock("@/modules/hostel-referrals/hostel-referral.service", () => ({
  settleHostelReferrals: vi.fn(),
}));

vi.mock("@hostel/db/models/AuditLog", () => ({
  AuditLogModel: { create: mocks.auditCreate },
}));

vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: { findById: mocks.hostelFindById, updateOne: mocks.hostelUpdateOne },
}));

vi.mock("@hostel/db/models/User", () => ({
  UserModel: { findById: mocks.userFindById },
}));

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
    findOneAndUpdate: mocks.invoiceFindOneAndUpdate,
    updateOne: mocks.invoiceUpdateOne,
  },
}));

vi.mock("@hostel/db/models/PlatformDocumentSequence", () => ({
  PlatformDocumentSequenceModel: {
    findOneAndUpdate: mocks.documentSequenceFindOneAndUpdate,
  },
}));

vi.mock("@hostel/db/models/SubscriptionPayment", () => ({
  SubscriptionPaymentModel: {
    aggregate: mocks.aggregate,
    create: mocks.paymentCreate,
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

vi.mock("@/modules/team/team-commission.service", () => ({
  creditTeamCommission: mocks.creditTeamCommission,
}));

vi.mock("@/modules/hostels/hostel-registration.events", () => ({
  onInvoiceIssued: mocks.onInvoiceIssued,
  onPaymentSettled: mocks.onPaymentSettled,
}));

import {
  SubscriptionError,
  getSubscriptionState,
  graceDeadline,
  issueSubscriptionInvoice,
  selectPlan,
  startPlanPeriod,
} from "@/modules/billing/subscription.service";
import { settlePayment } from "@/modules/billing/subscription-payment.service";
import { bsMonthsEnd } from "@hostel/shared/calendar/bs";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const otherHostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0c9");
const subscriptionId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a2");
const invoiceId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a3");
const paymentId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a4");
const actorId = "64f0f0f0f0f0f0f0f0f0f0a5";

/** A chainable stub standing in for a mongoose query. */
function query<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
  };
}

const catalog = {
  cycleLabels: { annual: "Yearly", halfYearly: "Half-yearly", monthly: "Monthly" },
  modules: [],
  plans: [
    {
      annualDiscountPercent: 0,
      ctaHref: "/register-hostel",
      ctaLabel: "Start",
      description: "",
      featured: false,
      halfYearlyDiscountPercent: 0,
      id: "pro",
      listingTier: null,
      maxResidents: null,
      monthly: 5900,
      name: "Pro Plan",
      portalAccess: { cooks: null, wardens: null },
    },
  ],
  services: [],
};

function subscription(overrides: Record<string, unknown> = {}) {
  return {
    _id: subscriptionId,
    currency: "NPR",
    cycle: "monthly",
    cycleMonths: 1,
    cycleTotal: 5900,
    hostelId,
    planId: "pro",
    planName: "Pro Plan",
    source: "PUBLIC",
    status: "SELECTED",
    ...overrides,
  };
}

function invoice(overrides: Record<string, unknown> = {}) {
  return {
    _id: invoiceId,
    amount: 5900,
    cycle: "monthly",
    cycleMonths: 1,
    hostelId,
    invoiceNumber: "SUB-0001-F0A1",
    planId: "pro",
    planName: "Pro Plan",
    source: "PUBLIC",
    status: "OPEN",
    subscriptionId,
    ...overrides,
  };
}

/** How much has settled against the invoice, as the aggregate would report it. */
function settledTotal(total: number) {
  mocks.aggregate.mockResolvedValue(total > 0 ? [{ total }] : []);
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSiteConfigSection.mockResolvedValue(catalog);
  mocks.getOperationsConfig.mockResolvedValue({ subscriptionDueGraceDays: 3 });
  mocks.counterFindOneAndUpdate.mockReturnValue(query({ sequence: 1 }));
  mocks.subscriptionUpdateOne.mockResolvedValue({});
  mocks.invoiceUpdateOne.mockResolvedValue({});
  mocks.paymentUpdateOne.mockResolvedValue({});
  /*
   * The claim that moves a payment out of `PENDING`. It answers a row by
   * default — this caller won the race — and one test overrides it with null to
   * stand for the second delivery of the same webhook.
   */
  mocks.paymentFindOneAndUpdate.mockReturnValue(query({ _id: paymentId }));
  mocks.hostelUpdateOne.mockResolvedValue({});
  mocks.auditCreate.mockResolvedValue({});
  mocks.paymentFind.mockReturnValue(query([]));
  mocks.userFindById.mockReturnValue(query({ email: "owner@example.com", name: "Owner" }));
  settledTotal(0);
});

describe("choosing a plan", () => {
  it("is allowed while the hostel is still unverified", async () => {
    mocks.subscriptionFindOne.mockReturnValue(
      query(subscription({ planId: null, planName: null, status: "PENDING_SELECTION" })),
    );
    mocks.invoiceFindOne.mockReturnValue(query(null));
    mocks.hostelFindById.mockReturnValue(
      query({ name: "Sunrise", status: "PENDING_APPROVAL", verificationStatus: "PENDING" }),
    );

    await selectPlan(hostelId.toString(), { cycle: "monthly", planId: "pro" }, actorId);

    expect(mocks.subscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: subscriptionId },
      expect.objectContaining({
        $set: expect.objectContaining({ planId: "pro", status: "SELECTED" }),
      }),
    );
  });

  it("refuses to change plan while an invoice is outstanding", async () => {
    mocks.subscriptionFindOne.mockReturnValue(query(subscription()));
    mocks.invoiceFindOne.mockReturnValue(query(invoice()));

    await expect(
      selectPlan(hostelId.toString(), { cycle: "monthly", planId: "pro" }, actorId),
    ).rejects.toThrow(/already outstanding/i);
  });
});

describe("the Pay now gate", () => {
  it("stays shut while unverified, even with a plan chosen", async () => {
    mocks.subscriptionFindOne.mockReturnValue(query(subscription()));
    mocks.invoiceFindOne.mockReturnValue(query(null));
    mocks.hostelFindById.mockReturnValue(
      query({ name: "Sunrise", status: "PENDING_APPROVAL", verificationStatus: "PENDING" }),
    );

    const state = await getSubscriptionState(hostelId.toString());

    expect(state?.canPayNow).toBe(false);
    expect(state?.planChosen).toBe(true);
  });

  it("stays shut when verified but no plan is chosen", async () => {
    mocks.subscriptionFindOne.mockReturnValue(
      query(subscription({ planId: null, planName: null, status: "PENDING_SELECTION" })),
    );
    mocks.invoiceFindOne.mockReturnValue(query(null));
    mocks.hostelFindById.mockReturnValue(
      query({ name: "Sunrise", status: "APPROVED", verificationStatus: "VERIFIED" }),
    );

    const state = await getSubscriptionState(hostelId.toString());

    expect(state?.canPayNow).toBe(false);
  });

  it("opens once verified and chosen", async () => {
    mocks.subscriptionFindOne.mockReturnValue(query(subscription()));
    mocks.invoiceFindOne.mockReturnValue(query(null));
    mocks.hostelFindById.mockReturnValue(
      query({ name: "Sunrise", status: "APPROVED", verificationStatus: "VERIFIED" }),
    );

    const state = await getSubscriptionState(hostelId.toString());

    expect(state?.canPayNow).toBe(true);
  });
});

describe("raising the invoice", () => {
  it("refuses before verification", async () => {
    mocks.subscriptionFindOne.mockReturnValue(query(subscription()));
    mocks.invoiceFindOne.mockReturnValue(query(null));
    mocks.hostelFindById.mockReturnValue(
      query({ name: "Sunrise", verificationStatus: "PENDING" }),
    );

    await expect(
      issueSubscriptionInvoice(hostelId.toString(), actorId),
    ).rejects.toBeInstanceOf(SubscriptionError);
    expect(mocks.invoiceCreate).not.toHaveBeenCalled();
  });

  it("returns the existing invoice rather than raising a second", async () => {
    mocks.subscriptionFindOne.mockReturnValue(query(subscription()));
    mocks.subscriptionFindById.mockReturnValue(query(subscription()));
    mocks.invoiceFindOne.mockReturnValue(query(invoice()));
    mocks.invoiceFindById.mockReturnValue(query(invoice()));
    mocks.documentSequenceFindOneAndUpdate.mockReturnValue(
      query({ sequence: 12 }),
    );
    mocks.invoiceFindOneAndUpdate.mockReturnValue(
      query({ localInvoiceNo: "HH-INV-2083/84-000012" }),
    );

    const result = await issueSubscriptionInvoice(hostelId.toString(), actorId);

    expect(result.invoiceNumber).toBe("SUB-0001-F0A1");
    expect(mocks.invoiceCreate).not.toHaveBeenCalled();
  });

  /*
   * Softmato is not configured in this suite, so every raise here fails. The
   * invoice must then wait for Softmato — never get a number of our own, which
   * would be a second invoice for the same money.
   */
  it("leaves the invoice waiting, with no stand-in number, when Softmato cannot raise it", async () => {
    mocks.subscriptionFindOne.mockReturnValue(query(subscription()));
    mocks.subscriptionFindById.mockReturnValue(query(subscription()));
    mocks.invoiceFindOne.mockReturnValue(query(invoice()));
    mocks.invoiceFindById.mockReturnValue(query(invoice()));

    const result = await issueSubscriptionInvoice(hostelId.toString(), actorId);

    expect(result.localInvoiceNo ?? null).toBeNull();
    expect(result.softmatoInvoiceNo ?? null).toBeNull();
    expect(mocks.documentSequenceFindOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("settling", () => {
  function arrangeSettlement(options: {
    alreadySettled?: number;
    amount: number;
    source?: "PUBLIC" | "TEAM";
  }) {
    mocks.paymentFindById.mockReturnValue(
      query({
        _id: paymentId,
        amount: options.amount,
        hostelId,
        invoiceId,
        method: "CASH",
        status: "PENDING",
        subscriptionId,
      }),
    );
    mocks.invoiceFindById.mockReturnValue(query(invoice()));
    mocks.subscriptionFindById.mockReturnValue(
      query({ _id: subscriptionId, cycleMonths: 1, source: options.source ?? "PUBLIC" }),
    );
    mocks.subscriptionFindOne.mockReturnValue(
      query(subscription({ source: options.source ?? "PUBLIC" })),
    );
    mocks.invoiceFindOne.mockReturnValue(query(invoice()));
    mocks.hostelFindById.mockReturnValue(
      query({
        name: "Sunrise",
        status: "APPROVED",
        verificationStatus: "VERIFIED",
      }),
    );
    settledTotal((options.alreadySettled ?? 0) + options.amount);
  }

  it("activates and publishes when paid in full", async () => {
    arrangeSettlement({ amount: 5900 });

    await settlePayment(paymentId.toString(), { actorId });

    expect(mocks.invoiceUpdateOne).toHaveBeenCalledWith(
      { _id: invoiceId },
      { $set: { status: "PAID" } },
    );
    expect(mocks.subscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: subscriptionId },
      expect.objectContaining({ $set: expect.objectContaining({ status: "ACTIVE" }) }),
    );
    expect(mocks.hostelUpdateOne).toHaveBeenCalledWith(
      { _id: hostelId },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "PUBLISHED" }),
      }),
    );
  });

  it("settles a setup fee without touching the plan, and credits the agent", async () => {
    arrangeSettlement({ amount: 500, source: "TEAM" });
    mocks.invoiceFindById.mockReturnValue(
      query(invoice({ amount: 500, kind: "SETUP_FEE", planName: "Setup fee", source: "TEAM" })),
    );

    await settlePayment(paymentId.toString(), { actorId });

    expect(mocks.invoiceUpdateOne).toHaveBeenCalledWith(
      { _id: invoiceId },
      { $set: { status: "PAID" } },
    );
    expect(mocks.subscriptionUpdateOne).not.toHaveBeenCalled();
    expect(mocks.hostelUpdateOne).not.toHaveBeenCalled();
    expect(mocks.creditTeamCommission).toHaveBeenCalledTimes(1);
  });

  it("pays no commission on the plan of a hostel that had a setup fee", async () => {
    arrangeSettlement({ amount: 5900, source: "TEAM" });
    mocks.invoiceFindById.mockReturnValue(query(invoice({ source: "TEAM" })));
    mocks.invoiceExists.mockResolvedValue({ _id: new Types.ObjectId() });

    await settlePayment(paymentId.toString(), { actorId });

    expect(mocks.creditTeamCommission).not.toHaveBeenCalled();
  });

  it("still pays commission on the plan of a team hostel filed before setup fees", async () => {
    arrangeSettlement({ amount: 5900, source: "TEAM" });
    mocks.invoiceFindById.mockReturnValue(query(invoice({ source: "TEAM" })));
    mocks.invoiceExists.mockResolvedValue(null);

    await settlePayment(paymentId.toString(), { actorId });

    expect(mocks.creditTeamCommission).toHaveBeenCalledTimes(1);
  });

  it("leaves a team hostel published and past due when part paid", async () => {
    arrangeSettlement({ amount: 2000, source: "TEAM" });

    await settlePayment(paymentId.toString(), { actorId });

    expect(mocks.invoiceUpdateOne).toHaveBeenCalledWith(
      { _id: invoiceId },
      { $set: { status: "PARTIAL" } },
    );
    expect(mocks.subscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: subscriptionId },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "PAST_DUE" }),
      }),
    );
  });

  /*
   * A part payment used to set the due to "now plus the grace period", so each
   * instalment bought another one. The deadline is the invoice's and stays put.
   */
  it("keeps the deadline the invoice was raised with when part paid", async () => {
    const dueAt = new Date("2026-09-13T18:14:59.999Z");

    arrangeSettlement({ amount: 1400, source: "TEAM" });
    mocks.invoiceFindById.mockReturnValue(query(invoice({ dueAt })));

    await settlePayment(paymentId.toString(), { actorId });

    expect(mocks.subscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: subscriptionId },
      { $set: { dueBy: dueAt, status: "PAST_DUE" } },
    );
  });

  /*
   * A team hostel's plan started the day it was filed. Paying the balance off a
   * few days later must not start it again from that later day — the owner
   * would be handed a month ending later than the one on their invoice, and the
   * bar they have been watching would jump back to full.
   */
  it("does not restart a team hostel's plan when the balance is paid off", async () => {
    const periodEnd = new Date("2026-10-11T18:14:59.999Z");

    arrangeSettlement({ alreadySettled: 1000, amount: 4900, source: "TEAM" });
    mocks.invoiceFindById.mockReturnValue(
      query(invoice({ periodEnd, source: "TEAM" })),
    );
    mocks.subscriptionFindById.mockReturnValue(
      query({
        _id: subscriptionId,
        activatedAt: new Date("2026-09-11T05:30:31.571Z"),
        currentPeriodEnd: periodEnd,
        cycleMonths: 1,
        source: "TEAM",
      }),
    );

    await settlePayment(paymentId.toString(), { actorId });

    expect(mocks.subscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: subscriptionId },
      { $set: { dueBy: null, status: "ACTIVE" } },
    );
    expect(mocks.subscriptionUpdateOne).not.toHaveBeenCalledWith(
      { _id: subscriptionId },
      expect.objectContaining({
        $set: expect.objectContaining({ currentPeriodEnd: expect.anything() }),
      }),
    );
  });

  it("does not publish a public hostel that has only part paid", async () => {
    arrangeSettlement({ amount: 2000, source: "PUBLIC" });

    await settlePayment(paymentId.toString(), { actorId });

    expect(mocks.hostelUpdateOne).not.toHaveBeenCalled();
    // A public shortfall is not a due — it is simply not paid for yet.
    expect(mocks.subscriptionUpdateOne).not.toHaveBeenCalledWith(
      { _id: subscriptionId },
      expect.objectContaining({
        $set: expect.objectContaining({ status: "PAST_DUE" }),
      }),
    );
  });

  it("issues one receipt when the same payment settles twice", async () => {
    mocks.paymentFindById.mockReturnValue(
      query({
        _id: paymentId,
        amount: 5900,
        hostelId,
        invoiceId,
        method: "CASH",
        status: "SETTLED",
        subscriptionId,
      }),
    );
    /*
     * The claim is what makes this idempotent, and it is what is stubbed here.
     * `findOneAndUpdate({ status: "PENDING" })` matches nothing once a row has
     * settled, so the second caller gets null and stops — which is the point:
     * a webhook delivered twice concurrently would both pass a plain status
     * *read*, and only one can win a conditional *write*.
     */
    mocks.paymentFindOneAndUpdate.mockReturnValue(query(null));
    mocks.subscriptionFindOne.mockReturnValue(query(subscription()));
    mocks.invoiceFindOne.mockReturnValue(query(invoice({ status: "PAID" })));
    mocks.hostelFindById.mockReturnValue(
      query({ name: "Sunrise", status: "PUBLISHED", verificationStatus: "VERIFIED" }),
    );

    await settlePayment(paymentId.toString(), { actorId });

    expect(mocks.counterFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mocks.paymentUpdateOne).not.toHaveBeenCalled();
  });

  it("refuses a payment belonging to another hostel", async () => {
    mocks.paymentFindById.mockReturnValue(
      query({
        _id: paymentId,
        amount: 5900,
        hostelId: otherHostelId,
        invoiceId,
        method: "CASH",
        status: "PENDING",
        subscriptionId,
      }),
    );

    await expect(
      settlePayment(paymentId.toString(), {
        actorId,
        expectedHostelId: hostelId.toString(),
      }),
    ).rejects.toThrow(/not found/i);
    expect(mocks.paymentUpdateOne).not.toHaveBeenCalled();
  });
});

describe("the grace deadline", () => {
  it("is the end of the Nepal day, grace days after the invoice", () => {
    // Added at 3:20 pm in Kathmandu on Bhadra 25, 2083 (10 Sep 2026): due by
    // the last moment of Bhadra 28.
    const added = new Date("2026-09-10T09:35:34Z");

    expect(graceDeadline(added, 3).toISOString()).toBe("2026-09-13T18:14:59.999Z");
  });

  it("counts from the Nepal day, not the UTC one", () => {
    // 11 pm UTC on the 9th is already 4:45 am on the 10th in Kathmandu.
    const lateUtc = new Date("2026-09-09T23:00:00Z");

    expect(graceDeadline(lateUtc, 3).toISOString()).toBe("2026-09-13T18:14:59.999Z");
  });
});

describe("the plan's period", () => {
  // Filed at 11:15 am in Kathmandu on Bhadra 26, 2083 (11 Sep 2026).
  const filed = new Date("2026-09-11T05:30:31.571Z");
  // The last instant of Aswin 25: a monthly plan taken on Bhadra 26 renews on
  // Aswin 26.
  const throughAswin25 = new Date("2026-10-11T18:14:59.999Z");

  it("starts the day the hostel goes live and runs one Bikram Sambat month", async () => {
    mocks.subscriptionFindById.mockReturnValue(
      query({ _id: subscriptionId, activatedAt: null, currentPeriodEnd: null }),
    );

    await startPlanPeriod(invoice(), filed);

    expect(mocks.subscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: subscriptionId },
      { $set: { activatedAt: filed, currentPeriodEnd: throughAswin25 } },
    );
  });

  it("extends a running period rather than overlapping it", async () => {
    // Renewed on Aswin 15, ten days before the running month is out.
    const renewing = new Date("2026-10-01T06:00:00Z");

    mocks.subscriptionFindById.mockReturnValue(
      query({ _id: subscriptionId, activatedAt: filed, currentPeriodEnd: throughAswin25 }),
    );

    await startPlanPeriod(invoice(), renewing);

    expect(mocks.subscriptionUpdateOne).toHaveBeenCalledWith(
      { _id: subscriptionId },
      {
        $set: {
          // The stretch still began on Bhadra 26 — the bar spans all of it.
          activatedAt: filed,
          currentPeriodEnd: bsMonthsEnd(new Date(throughAswin25.getTime() + 1), 1),
        },
      },
    );
  });
});

describe("what counts toward the balance", () => {
  it("ignores a pending payment", async () => {
    // The aggregate matches `status: SETTLED`, so a pending row contributes
    // nothing — this pins that the filter is actually on the query.
    mocks.subscriptionFindOne.mockReturnValue(query(subscription()));
    mocks.invoiceFindOne.mockReturnValue(query(invoice()));
    mocks.hostelFindById.mockReturnValue(
      query({ name: "Sunrise", status: "APPROVED", verificationStatus: "VERIFIED" }),
    );
    settledTotal(0);

    const state = await getSubscriptionState(hostelId.toString());

    expect(state?.outstanding).toBe(5900);
    expect(mocks.aggregate).toHaveBeenCalledWith([
      { $match: { invoiceId, status: "SETTLED" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]);
  });
});
