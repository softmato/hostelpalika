import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

import type { FakeModel } from "../../../test/fake-mongo";

/**
 * A branch has to be the same business before anyone sees it: the main
 * hostel's PAN, a payout account in the main hostel's verified holder name,
 * room under the plan's cap — and then it only waits for a superadmin.
 */

const state = vi.hoisted(() => ({
  bells: [] as Array<{ title: string }>,
  plan: { maxBranches: 3, name: "Max", status: "ACTIVE" },
  savedPayout: [] as string[],
}));

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
vi.mock("@hostel/db/models/HostelApplication", fake("HostelApplicationModel"));
vi.mock("@hostel/db/models/HostelDocument", fake("HostelDocumentModel"));
vi.mock("@hostel/db/models/HostelPayoutAccount", fake("HostelPayoutAccountModel"));
vi.mock("@hostel/db/models/HostelVerification", fake("HostelVerificationModel"));
vi.mock("@hostel/db/models/User", fake("UserModel"));
vi.mock("@/lib/registration-documents", () => ({
  claimRegistrationDocuments: vi.fn(async (documents: Array<{ documentType: string }>) =>
    documents.map((document) => ({ documentType: document.documentType, fileAssetId: new Types.ObjectId() })),
  ),
}));
vi.mock("@/modules/billing/subscription-access", () => ({
  resolveOwnedHostel: vi.fn(async (hostelId: string) => ({ _id: new Types.ObjectId(hostelId), name: "Main" })),
}));
vi.mock("@/modules/billing/subscription.service", () => ({
  getSubscriptionState: vi.fn(async () => ({
    subscription: { planId: "max", planName: state.plan.name, status: state.plan.status },
  })),
}));
vi.mock("@/modules/platform-config/site-config.service", () => ({
  getSiteConfigSection: vi.fn(async () => ({
    plans: [{ id: "max", maxBranches: state.plan.maxBranches, name: state.plan.name }],
  })),
}));
vi.mock("@/modules/bookings/payout-account.service", () => ({
  setHostelPayoutAccount: vi.fn(async (hostelId: string) => {
    state.savedPayout.push(hostelId);
  }),
}));
vi.mock("@/modules/notifications/notification.service", () => ({
  createInAppNotification: vi.fn(async (input: { title: string }) => {
    state.bells.push(input);
  }),
}));

const { requestBranch } = await import("./hostel-branch.service");
const { HostelModel } = await import("@hostel/db/models/Hostel");
const { HostelPayoutAccountModel } = await import("@hostel/db/models/HostelPayoutAccount");
const { UserModel } = await import("@hostel/db/models/User");

const hostels = HostelModel as unknown as FakeModel;
const payouts = HostelPayoutAccountModel as unknown as FakeModel;
const mainId = new Types.ObjectId();
const ownerId = new Types.ObjectId();
const principal = { hostelIds: [mainId.toString()], role: Role.HOSTEL_ADMIN, userId: ownerId.toString() };

function input(overrides: Record<string, unknown> = {}) {
  return {
    contact: { phone: "9811111111" },
    documents: [{ claimToken: "x".repeat(24), documentType: "PAN / VAT document", fileAssetId: new Types.ObjectId().toString() }],
    facilities: [],
    hostelType: "CO_LIVING",
    location: { area: "Lazimpat", city: "Kathmandu" },
    name: "Study Sanjal Lazimpat",
    panNumber: "601234567",
    payoutAccount: { bankName: "NIC Asia", branch: "", holderName: "RAM  Sharma", method: "BANK", number: "123456789" },
    photos: [],
    roomConfigurations: [],
    roomTypes: [],
    rules: [],
    ...overrides,
  } as unknown as Parameters<typeof requestBranch>[1];
}

beforeEach(() => {
  state.bells.length = 0;
  state.savedPayout.length = 0;
  state.plan = { maxBranches: 3, name: "Max", status: "ACTIVE" };
  hostels.reset([
    { _id: mainId, location: { area: "Baneshwor" }, name: "Study Sanjal", ownerId, panNumber: "601234567", parentHostelId: null, slug: "study-sanjal", status: "PUBLISHED" },
  ]);
  payouts.reset([{ hostelId: mainId, holderName: "Ram Sharma", status: "VERIFIED" }]);
  (UserModel as unknown as FakeModel).reset([{ _id: new Types.ObjectId(), role: Role.SUPERADMIN, status: "ACTIVE" }]);
});

describe("requestBranch", () => {
  it("files a matching branch as pending, under the main hostel, and rings the superadmins", async () => {
    const result = await requestBranch(mainId.toString(), input(), principal);

    const branch = hostels.docs.find((doc) => String(doc._id) === result.branch.id);
    expect(branch).toMatchObject({ parentHostelId: mainId, status: "PENDING_APPROVAL", verificationStatus: "PENDING" });
    expect(String(branch?.ownerId)).toBe(String(ownerId));
    expect(state.savedPayout).toEqual([result.branch.id]);
    expect(state.bells[0]?.title).toBe("Branch waiting for a call");
  });

  it("refuses another business's PAN", async () => {
    await expect(requestBranch(mainId.toString(), input({ panNumber: "609999999" }), principal)).rejects.toThrow(
      "same PAN/VAT number",
    );
  });

  it("refuses a payout account in someone else's name", async () => {
    await expect(
      requestBranch(
        mainId.toString(),
        input({ payoutAccount: { bankName: "NIC Asia", branch: "", holderName: "Hari Thapa", method: "BANK", number: "123456789" } }),
        principal,
      ),
    ).rejects.toThrow("same name as the main hostel");
  });

  it("refuses while the main payout account is unverified", async () => {
    payouts.reset([{ hostelId: mainId, holderName: "Ram Sharma", status: "PENDING_REVIEW" }]);

    await expect(requestBranch(mainId.toString(), input(), principal)).rejects.toThrow("has to be verified");
  });

  it("stops at the plan's cap, counting branches still pending", async () => {
    state.plan.maxBranches = 1;
    hostels.docs.push({ _id: new Types.ObjectId(), parentHostelId: mainId, status: "PENDING_APPROVAL" });

    await expect(requestBranch(mainId.toString(), input(), principal)).rejects.toThrow("includes 1 branch");
  });

  it("refuses on a plan with no branches", async () => {
    state.plan = { maxBranches: 0, name: "Go", status: "ACTIVE" };

    await expect(requestBranch(mainId.toString(), input(), principal)).rejects.toThrow("Go has none");
  });
});
