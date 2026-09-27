import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a team filing does with money: the plan starts free and the agent's
 * collection is the setup fee — unless the building has had its free months,
 * or the payment was taken for the plan before setup fees existed.
 */

const mocks = vi.hoisted(() => ({
  fileFieldCash: vi.fn(),
  issueSetupFeeInvoice: vi.fn(),
  issueSubscriptionInvoice: vi.fn(),
  reconcile: vi.fn(),
  settleTeamPrepayment: vi.fn(),
  startFreeMonths: vi.fn(),
  startPlanPeriod: vi.fn(),
  subscriptionUpdateOne: vi.fn(),
}));

vi.mock("@/modules/billing/cash-filing.service", () => ({ fileFieldCash: mocks.fileFieldCash }));
vi.mock("@/modules/billing/subscription-payment.service", () => ({
  startFreeMonths: mocks.startFreeMonths,
}));
vi.mock("@/modules/billing/subscription-reconcile.service", () => ({
  reconcileInvoiceFromSoftmato: mocks.reconcile,
}));
vi.mock("@/modules/billing/subscription.service", () => ({
  getOrCreateSubscription: vi.fn(),
  graceDeadline: vi.fn(() => new Date("2026-09-30T18:14:59Z")),
  issueSetupFeeInvoice: mocks.issueSetupFeeInvoice,
  issueSubscriptionInvoice: mocks.issueSubscriptionInvoice,
  selectPlan: vi.fn(),
  startPlanPeriod: mocks.startPlanPeriod,
}));
vi.mock("@/modules/platform-config/operations-config", () => ({
  getOperationsConfig: vi.fn(async () => ({ subscriptionDueGraceDays: 3 })),
}));
vi.mock("@/modules/team/team-prepayment.service", () => ({
  settleTeamPrepayment: mocks.settleTeamPrepayment,
}));
vi.mock("@hostel/db/models/HostelSubscription", () => ({
  HostelSubscriptionModel: { updateOne: mocks.subscriptionUpdateOne },
}));

const { fileTeamBilling } = await import("./team-filing-billing");

const hostelId = new Types.ObjectId();
const agent = { name: "Agent", userId: new Types.ObjectId().toString() };
const cash = { payment: { amount: 500, reference: "slip 7" }, plan: { cycle: "monthly" as const, planId: "go" } };
const setupInvoice = { _id: new Types.ObjectId(), amount: 500 };
const planInvoice = { _id: new Types.ObjectId(), dueAt: new Date("2026-09-30T18:14:59Z"), issuedAt: new Date() };

function prepayment(kind: "PLAN" | "SETUP_FEE", paid = true) {
  return {
    amount: kind === "PLAN" ? 999 : 500,
    invoiceNumber: "SUB-0001-ABCD",
    kind,
    paid,
    softmatoInvoiceId: "si_1",
    softmatoInvoiceNo: "INV-1",
  } as unknown as Parameters<typeof fileTeamBilling>[3];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.issueSetupFeeInvoice.mockResolvedValue(setupInvoice);
  mocks.issueSubscriptionInvoice.mockResolvedValue(planInvoice);
  mocks.startFreeMonths.mockResolvedValue({ freeMonths: 6, freeUntil: new Date() });
});

describe("fileTeamBilling", () => {
  it("starts the free months, raises no plan invoice, and files the cash as the setup fee", async () => {
    const result = await fileTeamBilling(hostelId, cash, agent, null);

    expect(result.free?.freeMonths).toBe(6);
    expect(mocks.issueSubscriptionInvoice).not.toHaveBeenCalled();
    expect(mocks.issueSetupFeeInvoice).toHaveBeenCalledWith(hostelId.toString(), 500, agent.userId, {});
    expect(mocks.fileFieldCash).toHaveBeenCalledWith(
      setupInvoice._id.toString(),
      { amount: 500, reference: "slip 7" },
      { name: "Agent", userId: agent.userId },
    );
  });

  it("bills the plan from today when the building has had its free months, and still takes the setup fee", async () => {
    mocks.startFreeMonths.mockResolvedValue(null);

    await fileTeamBilling(hostelId, cash, agent, null);

    expect(mocks.issueSubscriptionInvoice).toHaveBeenCalledTimes(1);
    expect(mocks.startPlanPeriod).toHaveBeenCalledTimes(1);
    expect(mocks.subscriptionUpdateOne).toHaveBeenCalledWith(
      { hostelId },
      { $set: { dueBy: planInvoice.dueAt, status: "PAST_DUE" } },
    );
    expect(mocks.fileFieldCash).toHaveBeenCalledTimes(1);
  });

  it("settles an online setup fee against its own invoice", async () => {
    await fileTeamBilling(hostelId, cash, agent, prepayment("SETUP_FEE"));

    expect(mocks.issueSetupFeeInvoice).toHaveBeenCalledWith(
      hostelId.toString(),
      500,
      agent.userId,
      { prepaid: { invoiceNumber: "SUB-0001-ABCD", softmatoInvoiceId: "si_1", softmatoInvoiceNo: "INV-1" } },
    );
    expect(mocks.settleTeamPrepayment).toHaveBeenCalledWith(expect.anything(), setupInvoice, agent.userId);
    expect(mocks.fileFieldCash).not.toHaveBeenCalled();
  });

  it("lets a plan payment taken before setup fees pay the plan, with no free months and no fee", async () => {
    const result = await fileTeamBilling(hostelId, cash, agent, prepayment("PLAN"));

    expect(mocks.startFreeMonths).not.toHaveBeenCalled();
    expect(mocks.issueSubscriptionInvoice.mock.calls[0][2]).toMatchObject({
      prepaid: { amount: 999, invoiceNumber: "SUB-0001-ABCD" },
    });
    expect(mocks.settleTeamPrepayment).toHaveBeenCalledWith(expect.anything(), planInvoice, agent.userId);
    expect(mocks.issueSetupFeeInvoice).not.toHaveBeenCalled();
    expect(result.setupFee).toBeNull();
  });
});
