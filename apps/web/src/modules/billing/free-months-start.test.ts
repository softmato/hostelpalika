import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { bsMonthsEnd } from "@hostel/shared/calendar/bs";

import type { FakeModel } from "../../../test/fake-mongo";

/**
 * Going live on free months: a verified hostel with a plan runs ACTIVE until
 * `freeUntil` with no invoice, and the same building registered again gets
 * none and is left on the paid path.
 */

const granted = vi.hoisted(() => [] as string[]);

function fake(exportName: string) {
  return async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const actual = await importOriginal();
    const { fakeModel } = await import("../../../test/fake-mongo");

    return { ...actual, [exportName]: fakeModel() };
  };
}

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@hostel/db/models/AuditLog", fake("AuditLogModel"));
vi.mock("@hostel/db/models/FreePlanClaim", fake("FreePlanClaimModel"));
vi.mock("@hostel/db/models/Hostel", fake("HostelModel"));
vi.mock("@hostel/db/models/HostelSubscription", fake("HostelSubscriptionModel"));
vi.mock("@hostel/db/models/User", fake("UserModel"));
vi.mock("@/modules/hostels/hostel-suspension", () => ({ liftHostelSuspension: vi.fn() }));
vi.mock("@/modules/hostel-referrals/hostel-referral.service", () => ({
  settleHostelReferrals: vi.fn(),
}));
vi.mock("@/modules/hostels/hostel.service", () => ({
  grantHostelOwnerAccess: vi.fn(async (hostelId: string) => {
    granted.push(hostelId);
    return true;
  }),
}));

const { startFreeMonths } = await import("./subscription-payment.service");
const { FreePlanClaimModel } = await import("@hostel/db/models/FreePlanClaim");
const { HostelModel } = await import("@hostel/db/models/Hostel");
const { HostelSubscriptionModel } = await import("@hostel/db/models/HostelSubscription");
const { UserModel } = await import("@hostel/db/models/User");

const models = {
  claims: FreePlanClaimModel as unknown as FakeModel,
  hostels: HostelModel as unknown as FakeModel,
  subscriptions: HostelSubscriptionModel as unknown as FakeModel,
  users: UserModel as unknown as FakeModel,
};

const ownerA = new Types.ObjectId();
const ownerB = new Types.ObjectId();
const hostelA = new Types.ObjectId();
const hostelB = new Types.ObjectId();

function hostel(_id: Types.ObjectId, ownerId: Types.ObjectId) {
  return {
    _id,
    location: { area: "Baneshwor" },
    name: "Study Sanjal Hostel",
    ownerId,
    status: "APPROVED",
    verificationStatus: "VERIFIED",
  };
}

function subscription(hostelId: Types.ObjectId) {
  return { hostelId, freeMonths: 6, planId: "go", source: "PUBLIC", status: "SELECTED" };
}

beforeEach(() => {
  granted.length = 0;
  models.claims.reset();
  models.users.reset([
    { _id: ownerA, phone: "9800000000" },
    { _id: ownerB, phone: "9811111111" },
  ]);
  models.hostels.reset([hostel(hostelA, ownerA), hostel(hostelB, ownerB)]);
  models.subscriptions.reset([subscription(hostelA), subscription(hostelB)]);
});

describe("startFreeMonths", () => {
  it("puts a verified hostel live on its plan's free months, with no invoice", async () => {
    const from = new Date("2026-09-26T06:00:00Z");
    const result = await startFreeMonths(hostelA.toString(), "actor", from);

    expect(result?.freeMonths).toBe(6);
    expect(result?.freeUntil.getTime()).toBe(bsMonthsEnd(from, 6).getTime());

    const row = models.subscriptions.docs.find((doc) => String(doc.hostelId) === String(hostelA));
    expect(row).toMatchObject({ freeMonths: 6, status: "ACTIVE" });
    expect((row?.currentPeriodEnd as Date).getTime()).toBe(bsMonthsEnd(from, 6).getTime());
    expect(models.hostels.docs.find((doc) => String(doc._id) === String(hostelA))?.status).toBe("PUBLISHED");
    expect(granted).toEqual([hostelA.toString()]);
  });

  it("never gives a hostel its free months twice", async () => {
    const first = await startFreeMonths(hostelA.toString(), "actor");
    const second = await startFreeMonths(hostelA.toString(), "actor");

    expect(second?.freeUntil.getTime()).toBe(first?.freeUntil.getTime());
    expect(models.claims.docs).toHaveLength(1);
  });

  it("gives the same building under another account nothing, and leaves it on the paid path", async () => {
    await startFreeMonths(hostelA.toString(), "actor");
    const again = await startFreeMonths(hostelB.toString(), "actor");

    expect(again).toBeNull();

    const row = models.subscriptions.docs.find((doc) => String(doc.hostelId) === String(hostelB));
    expect(row).toMatchObject({ freeMonths: 0, status: "SELECTED" });
    expect(models.hostels.docs.find((doc) => String(doc._id) === String(hostelB))?.status).toBe("APPROVED");
    expect(models.claims.docs.find((doc) => String(doc.hostelId) === String(hostelB))?.matchedHostelId)
      .toEqual(hostelA);
  });
});
