import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  issueInvoiceDocument: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/lib/site", () => ({ siteUrl: () => "https://example.test" }));
vi.mock("@/modules/billing/softmato/config", () => ({ isSoftmatoConfigured: () => true }));
vi.mock("@/modules/billing/softmato/invoice", () => ({
  servicePeriod: () => ({ endsAt: new Date(), startsAt: new Date() }),
}));
vi.mock("@/modules/billing/subscription-payment.service", () => ({ settlePayment: vi.fn() }));
vi.mock("@/modules/billing/billing-gateway", () => ({
  fetchInvoiceDetail: vi.fn(),
  issueInvoiceDocument: mocks.issueInvoiceDocument,
  openCheckoutSession: vi.fn(async () => ({ checkoutUrl: "https://pay.test", expiresAt: null })),
}));
vi.mock("@/modules/billing/subscription.service", () => ({
  allocateNumber: vi.fn(async () => "SUB-1"),
  invoiceDocumentInput: vi.fn(async (row: { amount: number }) => ({
    amount: row.amount,
    description: "Basic — 1 month",
  })),
  pricePlan: vi.fn(async () => ({
    cycle: "monthly",
    cycleMonths: 1,
    cycleTotal: 1000,
    planId: "basic",
    planName: "Basic",
  })),
  SubscriptionError: class extends Error {},
}));
vi.mock("@/modules/platform-config/operations-config", () => ({
  getOperationsConfig: vi.fn(async () => ({ teamSetupFee: 500 })),
}));
vi.mock("@hostel/db/models/AuditLog", () => ({ AuditLogModel: { create: vi.fn() } }));
vi.mock("@hostel/db/models/SubscriptionPayment", () => ({ SubscriptionPaymentModel: {} }));
vi.mock("@hostel/db/models/TeamPrepayment", () => ({
  TeamPrepaymentModel: { create: mocks.create, updateOne: vi.fn() },
}));

import { openTeamPrepayment } from "@/modules/team/team-prepayment.service";

const agent = { role: "PLATFORM_AGENT", userId: new Types.ObjectId().toString() };
const input = {
  area: "Baneshwor",
  cycle: "monthly" as const,
  hostelName: "Test Hostel",
  ownerName: "Owner",
  phone: "9800000000",
  planId: "basic",
};

describe("openTeamPrepayment takes the setup fee", () => {
  beforeEach(() => {
    mocks.create.mockReset().mockImplementation(async (doc: object) => ({
      toObject: () => ({ ...doc, _id: new Types.ObjectId() }),
    }));
    mocks.issueInvoiceDocument
      .mockReset()
      .mockResolvedValue({ softmatoInvoiceId: "si_1", softmatoInvoiceNo: "INV-1" });
  });

  it("charges the platform's fee when the form names none, and records the plan chosen", async () => {
    const result = await openTeamPrepayment(input, agent);

    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      amount: 500,
      chargeAmount: null,
      kind: "SETUP_FEE",
      planId: "basic",
    });
    expect(mocks.issueInvoiceDocument.mock.calls[0][0]).toMatchObject({ amount: 500 });
    expect(result.prepayment).toMatchObject({ amount: 500, kind: "SETUP_FEE" });
  });

  it("takes a lower fee the agent agreed", async () => {
    await openTeamPrepayment({ ...input, amount: 300 }, agent);

    expect(mocks.create.mock.calls[0][0]).toMatchObject({ amount: 300 });
    expect(mocks.issueInvoiceDocument.mock.calls[0][0]).toMatchObject({ amount: 300 });
  });

  it("refuses more than the platform's fee", async () => {
    await expect(openTeamPrepayment({ ...input, amount: 501 }, agent)).rejects.toThrow(
      "can't be more than that",
    );
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
