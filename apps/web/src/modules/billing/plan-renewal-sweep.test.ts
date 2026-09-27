import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeModel } from "../../../test/fake-mongo";

const calls = vi.hoisted(() => ({
  emails: [] as Array<{ amount: number; invoiceNumber: string }>,
  raised: [] as Array<{ agreed?: { cycleTotal: number }; dueAt?: Date; hostelId: string }>,
}));

function fake(exportName: string) {
  return async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const actual = await importOriginal();
    const { fakeModel } = await import("../../../test/fake-mongo");

    return { ...actual, [exportName]: fakeModel() };
  };
}

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@hostel/db/models/Hostel", fake("HostelModel"));
vi.mock("@hostel/db/models/HostelSubscription", fake("HostelSubscriptionModel"));
vi.mock("@hostel/db/models/SubscriptionInvoice", fake("SubscriptionInvoiceModel"));
vi.mock("@hostel/db/models/User", fake("UserModel"));
vi.mock("@/modules/platform-config/site-config.service", () => ({
  getSiteConfigSection: vi.fn(async () => ({
    cycleLabels: { annual: "Annual", halfYearly: "6 months", monthly: "Monthly" },
  })),
}));
vi.mock("@/modules/hostels/hostel-registration.events", () => ({
  onInvoiceIssued: vi.fn(async (input: { amount: number; invoiceNumber: string }) => {
    calls.emails.push(input);
  }),
}));
vi.mock("@/modules/billing/subscription.service", () => ({
  raiseRenewalInvoice: vi.fn(
    async (
      hostelId: string,
      input: { cycle: string; planId: string },
      _actor: string | null,
      options: { agreed?: { cycleTotal: number }; dueAt?: Date },
    ) => {
      calls.raised.push({ agreed: options.agreed, dueAt: options.dueAt, hostelId });

      return {
        invoice: {
          amount: options.agreed?.cycleTotal ?? 1299,
          cycle: input.cycle,
          dueAt: options.dueAt,
          invoiceNumber: `SUB-${hostelId.slice(-4)}`,
          planName: "Go",
        },
        reused: false,
      };
    },
  ),
}));

const { raiseDueRenewals } = await import("./plan-renewal-sweep.service");
const { HostelModel } = await import("@hostel/db/models/Hostel");
const { HostelSubscriptionModel } = await import("@hostel/db/models/HostelSubscription");
const { SubscriptionInvoiceModel } = await import("@hostel/db/models/SubscriptionInvoice");

const hostels = HostelModel as unknown as FakeModel;
const subscriptions = HostelSubscriptionModel as unknown as FakeModel;
const invoices = SubscriptionInvoiceModel as unknown as FakeModel;

const now = new Date("2026-09-26T02:00:00Z");
const days = (count: number) => new Date(now.getTime() + count * 86_400_000);

const endingSoon = new Types.ObjectId();
const endingLater = new Types.ObjectId();
const lapsed = new Types.ObjectId();
const renewing = new Types.ObjectId();

function sub(hostelId: Types.ObjectId, currentPeriodEnd: Date, freeUntil: Date | null) {
  return {
    currentPeriodEnd,
    cycle: "monthly",
    cycleMonths: 1,
    cycleTotal: 999,
    freeUntil,
    hostelId,
    monthlyRate: 999,
    planId: "go",
    planName: "Go",
    status: "ACTIVE",
  };
}

beforeEach(() => {
  calls.emails.length = 0;
  calls.raised.length = 0;
  hostels.reset(
    [endingSoon, endingLater, lapsed, renewing].map((_id) => ({
      _id,
      name: "Hostel",
      slug: `h-${_id.toString().slice(-4)}`,
      status: "PUBLISHED",
    })),
  );
  subscriptions.reset([
    sub(endingSoon, days(5), days(5)),
    sub(endingLater, days(20), days(20)),
    sub(lapsed, days(-1), days(-1)),
    sub(renewing, days(3), days(-200)),
  ]);
  invoices.reset([]);
});

describe("raiseDueRenewals", () => {
  it("bills a plan ending within the week at the price agreed, due the day it ends", async () => {
    await raiseDueRenewals(now);

    const first = calls.raised.find((call) => call.hostelId === endingSoon.toString());
    expect(first?.agreed?.cycleTotal).toBe(999);
    expect(first?.dueAt?.getTime()).toBe(days(5).getTime());
    expect(calls.raised.some((call) => call.hostelId === endingLater.toString())).toBe(false);
    expect(calls.emails.some((email) => email.invoiceNumber.endsWith(endingSoon.toString().slice(-4)))).toBe(true);
  });

  it("prices a later renewal at today's catalogue", async () => {
    await raiseDueRenewals(now);

    expect(calls.raised.find((call) => call.hostelId === renewing.toString())?.agreed).toBeUndefined();
  });

  it("turns a plan that ran out with its bill open into PAST_DUE, without a second bill", async () => {
    const subscriptionId = subscriptions.docs.find((doc) => String(doc.hostelId) === String(lapsed))?._id;
    invoices.reset([{ dueAt: days(-1), status: "OPEN", subscriptionId }]);

    const totals = await raiseDueRenewals(now);

    expect(calls.raised.some((call) => call.hostelId === lapsed.toString())).toBe(false);
    expect(subscriptions.docs.find((doc) => String(doc.hostelId) === String(lapsed))).toMatchObject({
      status: "PAST_DUE",
    });
    expect(totals.lapsed).toBe(1);
  });
});
