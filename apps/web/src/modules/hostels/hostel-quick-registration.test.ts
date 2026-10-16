import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FakeModel } from "../../../test/fake-mongo";

/**
 * The quick sign-up: a signed-in PUBLIC account files three fields and gets
 * the hostel portal on a trial, with the KYC still to do.
 */

const notified = vi.hoisted(() => [] as string[]);

function fake(exportName: string) {
  return async (importOriginal: () => Promise<Record<string, unknown>>) => {
    const actual = await importOriginal();
    const { fakeModel } = await import("../../../test/fake-mongo");

    return { ...actual, [exportName]: fakeModel() };
  };
}

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@hostel/db/models/AuditLog", fake("AuditLogModel"));
vi.mock("@hostel/db/models/Hostel", fake("HostelModel"));
vi.mock("@hostel/db/models/HostelSubscription", fake("HostelSubscriptionModel"));
vi.mock("@hostel/db/models/User", fake("UserModel"));
vi.mock("@hostel/shared/email/sender", () => ({ sendEmail: vi.fn(async () => ({ sent: true })) }));
vi.mock("@/modules/hostels/hostel-notify", () => ({
  notifyHostelOwnerOf: vi.fn(async (_user: unknown, _hostel: unknown, message: { type: string }) => {
    notified.push(message.type);
  }),
}));
vi.mock("@/modules/hostel-referrals/hostel-referral.service", () => ({
  recordHostelReferral: vi.fn(),
  resolveHostelReferralCode: vi.fn(),
}));
vi.mock("@/modules/hostels/hostel-registration.events", () => ({ formatEmailDate: () => "Kartik 15" }));
vi.mock("@/modules/hostels/hostel.service", () => ({
  HostelServiceError: class extends Error {
    constructor(message: string, public errorCode: string, public status: number) {
      super(message);
    }
  },
  uniqueSlug: vi.fn(async (name: string) => name.toLowerCase().replace(/\s+/g, "-")),
}));
vi.mock("@/modules/billing/subscription-payment.service", () => ({
  trialWindow: vi.fn(async () => ({ days: 15, endsAt: new Date("2026-10-27T18:14:59Z") })),
}));
vi.mock("@/modules/billing/subscription.service", async () => {
  const { HostelSubscriptionModel } = await import("@hostel/db/models/HostelSubscription");
  const model = HostelSubscriptionModel as unknown as FakeModel;

  return {
    getOrCreateSubscription: vi.fn(async (hostelId: Types.ObjectId) => {
      const found = model.docs.find((doc) => String(doc.hostelId) === String(hostelId));
      if (found) return found;
      const created = await model.create({ hostelId, status: "PENDING_SELECTION" });
      return model.docs.find((doc) => String(doc._id) === String(created._id));
    }),
  };
});

const { quickRegisterHostel } = await import("./hostel-quick-registration.service");
const { HostelModel } = await import("@hostel/db/models/Hostel");
const { HostelSubscriptionModel } = await import("@hostel/db/models/HostelSubscription");
const { UserModel } = await import("@hostel/db/models/User");

const hostels = HostelModel as unknown as FakeModel;
const subscriptions = HostelSubscriptionModel as unknown as FakeModel;
const users = UserModel as unknown as FakeModel;

const userId = new Types.ObjectId();
const input = { hostelName: "Study Sanjal", ownerName: "Ram Thapa", phone: "9800000000" };

beforeEach(() => {
  notified.length = 0;
  hostels.reset();
  subscriptions.reset();
  users.reset([{ _id: userId, email: "ram@gmail.com", emailVerified: true, name: "Ram", role: "PUBLIC" }]);
});

describe("quickRegisterHostel", () => {
  it("opens the portal on a trial, with the hostel unlisted and its KYC to do", async () => {
    const result = await quickRegisterHostel(input, userId.toString());

    expect(result).toMatchObject({ name: "Study Sanjal", trialDays: 15 });
    expect(hostels.docs[0]).toMatchObject({
      kyc: { required: true, status: "DRAFT" },
      status: "DRAFT",
      verificationStatus: "UNVERIFIED",
    });
    expect(subscriptions.docs[0]).toMatchObject({ status: "ACTIVE", trialDays: 15 });
    expect(subscriptions.docs[0]!.planId).toBeUndefined();

    const user = users.docs[0]!;
    expect(user).toMatchObject({ name: "Ram Thapa", phone: "9800000000", role: "HOSTEL_ADMIN" });
    expect((user.hostelIds as unknown[]).map(String)).toEqual([String(hostels.docs[0]!._id)]);
    expect(notified).toEqual(["HOSTEL_PORTAL_OPEN", "HOSTEL_KYC"]);
  });

  it("refuses an account that already has a role", async () => {
    users.docs[0]!.role = "RESIDENT";

    await expect(quickRegisterHostel(input, userId.toString())).rejects.toMatchObject({
      errorCode: "ACCOUNT_HAS_ROLE",
    });
    expect(hostels.docs).toHaveLength(0);
  });

  it("refuses an unverified email", async () => {
    users.docs[0]!.emailVerified = false;

    await expect(quickRegisterHostel(input, userId.toString())).rejects.toMatchObject({
      errorCode: "EMAIL_NOT_VERIFIED",
    });
  });

  it("accepts an email-OTP sign-up, which stores only emailVerifiedAt", async () => {
    users.docs[0]!.emailVerified = undefined;
    users.docs[0]!.emailVerifiedAt = new Date();

    await quickRegisterHostel(input, userId.toString());

    expect(users.docs[0]!.role).toBe("HOSTEL_ADMIN");
  });

  it("finishes a half-done attempt on the same hostel instead of filing a second", async () => {
    await hostels.create({ kyc: { required: true }, name: "Study Sanjal", ownerId: userId, slug: "study-sanjal" });

    await quickRegisterHostel(input, userId.toString());

    expect(hostels.docs).toHaveLength(1);
    expect(users.docs[0]!.role).toBe("HOSTEL_ADMIN");
  });
});
