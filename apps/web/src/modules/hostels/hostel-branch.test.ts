import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

import type { FakeModel } from "../../../test/fake-mongo";

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
    documents.map((document) => ({
      documentType: document.documentType,
      fileAssetId: new Types.ObjectId(),
    })),
  ),
}));
vi.mock("@/modules/billing/subscription-access", () => ({
  resolveOwnedHostel: vi.fn(async (hostelId: string) => ({
    _id: new Types.ObjectId(hostelId),
    name: "Main",
  })),
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

const { requestBranch, branchRequestSchema, getBranchDetails } = await import("./hostel-branch.service");
const { HostelModel } = await import("@hostel/db/models/Hostel");
const { HostelPayoutAccountModel } =
  await import("@hostel/db/models/HostelPayoutAccount");
const { UserModel } = await import("@hostel/db/models/User");
const { HostelDocumentModel } = await import("@hostel/db/models/HostelDocument");
const documents = HostelDocumentModel as unknown as FakeModel;

const hostels = HostelModel as unknown as FakeModel;
const payouts = HostelPayoutAccountModel as unknown as FakeModel;
const mainId = new Types.ObjectId();
const ownerId = new Types.ObjectId();
const principal = {
  hostelIds: [mainId.toString()],
  role: Role.HOSTEL_ADMIN,
  userId: ownerId.toString(),
};

function input(overrides: Record<string, unknown> = {}) {
  return {
    contact: { phone: "9811111111" },
    documents: [
      {
        claimToken: "x".repeat(24),
        documentType: "PAN / VAT document",
        fileAssetId: new Types.ObjectId().toString(),
      },
    ],
    facilities: [],
    hostelType: "CO_LIVING",
    location: { area: "Lazimpat", city: "Kathmandu" },
    name: "Study Sanjal Lazimpat",
    panNumber: "601234567",
    payoutAccount: {
      bankName: "NIC Asia",
      branch: "",
      holderName: "RAM  Sharma",
      method: "BANK",
      number: "123456789",
    },
    photos: [],
    roomConfigurations: [],
    roomTypes: [],
    rules: [],
    ...overrides,
  } as unknown as Parameters<typeof requestBranch>[1];
}

beforeEach(() => {
  documents.reset([]);
  state.bells.length = 0;
  state.savedPayout.length = 0;
  state.plan = { maxBranches: 3, name: "Max", status: "ACTIVE" };
  hostels.reset([
    {
      _id: mainId,
      location: { area: "Baneshwor" },
      name: "Study Sanjal",
      ownerId,
      panNumber: "601234567",
      parentHostelId: null,
      slug: "study-sanjal",
      status: "PUBLISHED",
    },
  ]);
  payouts.reset([{ hostelId: mainId, holderName: "Ram Sharma", status: "VERIFIED" }]);
  (UserModel as unknown as FakeModel).reset([
    { _id: new Types.ObjectId(), role: Role.SUPERADMIN, status: "ACTIVE" },
  ]);
});

describe("getBranchDetails", () => {
  it("reads pending branches and their registration details", async () => {
    const id = new Types.ObjectId();
    hostels.docs.push({ _id: id, parentHostelId: mainId, ownerId, name: "Pending branch", slug: "pending", status: "PENDING_APPROVAL", location: { area: "Koteswor" }, securityDeposit: 2000 });
    documents.docs.push({ _id: new Types.ObjectId(), hostelId: id, documentType: "PAN / VAT document", status: "PENDING" });
    const result = await getBranchDetails(mainId.toString(), id.toString(), principal);
    expect(result.hostel).toMatchObject({ id: id.toString(), status: "PENDING_APPROVAL", securityDeposit: 2000 });
    expect(result.documents).toMatchObject([{ type: "PAN / VAT document", status: "PENDING" }]);
  });

  it("refuses hostels outside the owner's branch family", async () => {
    const id = new Types.ObjectId();
    hostels.docs.push({ _id: id, parentHostelId: new Types.ObjectId(), ownerId: new Types.ObjectId(), name: "Other hostel" });
    await expect(getBranchDetails(mainId.toString(), id.toString(), principal)).rejects.toMatchObject({ status: 404 });
    await expect(getBranchDetails(mainId.toString(), "invalid", principal)).rejects.toMatchObject({ status: 404 });
  });
});

describe("requestBranch", () => {
  it("allows the same hostel name and area label in another city", async () => {
    hostels.docs[0].location = { area: "Lazimpat", city: "Kathmandu" };
    const result = await requestBranch(
      mainId.toString(),
      input({ name: "Study Sanjal", location: { area: "Lazimpat", city: "Pokhara" } }),
      principal,
    );
    expect(result.branch.name).toBe("Study Sanjal");
  });

  it("persists the new location, building and independent living details", async () => {
    const details = branchRequestSchema.parse(
      input({
        name: "Study Sanjal",
        totalFloors: 4,
        totalCapacity: 30,
        yearEstablished: "2026",
        cookCount: 2,
        location: {
          area: "Lazimpat",
          city: "Kathmandu",
          lat: 27.72,
          lng: 85.32,
          locationSource: "MANUAL",
        },
        food: { hasVeg: true, hasNonVeg: false, mealsPerDay: 3 },
        facilities: ["Wi-Fi", "Study Room"],
        rules: ["Quiet after 10 pm"],
      }),
    );
    const result = await requestBranch(mainId.toString(), details, principal);
    expect(
      hostels.docs.find((doc) => String(doc._id) === result.branch.id),
    ).toMatchObject({
      name: "Study Sanjal",
      totalFloors: 4,
      yearEstablished: "2026",
      capacitySummary: { totalBeds: 30 },
      location: { lat: 27.72, lng: 85.32, locationSource: "MANUAL" },
      facilities: ["Wi-Fi", "Study Room"],
      food: { hasVeg: true, hasNonVeg: false, mealsPerDay: 3 },
      rules: ["Quiet after 10 pm"],
    });
  });

  it("reuses only approved documents from the owned main hostel and reviews them again", async () => {
    const approvedFile = new Types.ObjectId();
    documents.reset([
      {
        hostelId: mainId,
        ownerId,
        status: "APPROVED",
        documentType: "PAN / VAT document",
        fileAssetId: approvedFile,
      },
      {
        hostelId: mainId,
        ownerId,
        status: "REJECTED",
        documentType: "Rejected proof",
        fileAssetId: new Types.ObjectId(),
      },
      {
        hostelId: mainId,
        ownerId,
        status: "APPROVED",
        isDeleted: true,
        documentType: "Deleted proof",
        fileAssetId: new Types.ObjectId(),
      },
      {
        hostelId: new Types.ObjectId(),
        ownerId,
        status: "APPROVED",
        documentType: "Other hostel",
        fileAssetId: new Types.ObjectId(),
      },
      {
        hostelId: mainId,
        ownerId: new Types.ObjectId(),
        status: "APPROVED",
        documentType: "Other owner",
        fileAssetId: new Types.ObjectId(),
      },
    ]);
    const result = await requestBranch(
      mainId.toString(),
      branchRequestSchema.parse(
        input({ documents: [], reuseDocuments: true, panNumber: undefined }),
      ),
      principal,
    );
    const copied = documents.docs.filter(
      (doc) => String(doc.hostelId) === result.branch.id,
    );
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({
      fileAssetId: approvedFile,
      status: "PENDING",
      ownerId,
    });
    expect(
      hostels.docs.find((doc) => String(doc._id) === result.branch.id)?.panNumber,
    ).toBe("601234567");
  });

  it("lets an uploaded replacement override an approved shared document", async () => {
    const oldFile = new Types.ObjectId();
    documents.reset([
      {
        hostelId: mainId,
        ownerId,
        status: "APPROVED",
        documentType: "PAN / VAT document",
        fileAssetId: oldFile,
      },
    ]);
    const result = await requestBranch(
      mainId.toString(),
      input({ reuseDocuments: true }),
      principal,
    );
    const copied = documents.docs.filter(
      (doc) => String(doc.hostelId) === result.branch.id,
    );
    expect(copied).toHaveLength(1);
    expect(String(copied[0].fileAssetId)).not.toBe(String(oldFile));
  });

  it("rejects impossible vacancy, mismatched capacity and duplicate room types", () => {
    const room = {
      roomType: "Twin",
      rooms: 3,
      bedsPerRoom: 2,
      vacantBeds: 6,
      mealInclusion: "Included",
    };
    expect(
      branchRequestSchema.safeParse(
        input({ roomConfigurations: [{ ...room, vacantBeds: 7 }] }),
      ).success,
    ).toBe(false);
    expect(
      branchRequestSchema.safeParse(
        input({ roomConfigurations: [room], totalCapacity: 7 }),
      ).success,
    ).toBe(false);
    expect(
      branchRequestSchema.safeParse(
        input({ roomConfigurations: [room, { ...room, roomType: "twin" }] }),
      ).success,
    ).toBe(false);
    expect(
      branchRequestSchema.safeParse(
        input({ roomConfigurations: [room], totalCapacity: 6, totalFloors: 2 }),
      ).success,
    ).toBe(true);
  });

  it("retains the optional room security deposit and rejects fractional amounts", () => {
    const room = {
      roomType: "Single",
      rooms: 2,
      bedsPerRoom: 1,
      vacantBeds: 2,
      mealInclusion: "Included",
      securityDeposit: 5000,
    };
    expect(
      branchRequestSchema.parse(input({ roomConfigurations: [room] }))
        .roomConfigurations[0].securityDeposit,
    ).toBe(5000);
    expect(
      branchRequestSchema.safeParse(
        input({ roomConfigurations: [{ ...room, securityDeposit: 1.5 }] }),
      ).success,
    ).toBe(false);
  });

  it("files a matching branch as pending, under the main hostel, and rings the superadmins", async () => {
    const result = await requestBranch(mainId.toString(), input(), principal);

    const branch = hostels.docs.find((doc) => String(doc._id) === result.branch.id);
    expect(branch).toMatchObject({
      parentHostelId: mainId,
      status: "PENDING_APPROVAL",
      verificationStatus: "PENDING",
    });
    expect(String(branch?.ownerId)).toBe(String(ownerId));
    expect(state.savedPayout).toEqual([result.branch.id]);
    expect(state.bells[0]?.title).toBe("Branch waiting for a call");
  });

  it("accepts a different PAN and independent account holder", async () => {
    const result = await requestBranch(
      mainId.toString(),
      input({
        panNumber: "609999999",
        payoutAccount: {
          bankName: "Nabil",
          branch: "",
          holderName: "Branch Business",
          method: "BANK",
          number: "987654321",
        },
      }),
      principal,
    );
    expect(
      hostels.docs.find((doc) => String(doc._id) === result.branch.id)?.panNumber,
    ).toBe("609999999");
    expect(state.savedPayout).toEqual([result.branch.id]);
  });

  it("creates multiple branches under the same owner without the first hostel's PAN or payout", async () => {
    delete hostels.docs[0].panNumber;
    payouts.reset([]);
    const minimal = branchRequestSchema.parse({
      name: "New branch",
      location: { area: "Patan" },
      contact: { phone: "9811111111" },
    });
    const first = await requestBranch(mainId.toString(), minimal, principal);
    const second = await requestBranch(
      mainId.toString(),
      { ...minimal, name: "Second branch" },
      principal,
    );
    for (const id of [first.branch.id, second.branch.id]) {
      expect(hostels.docs.find((doc) => String(doc._id) === id)).toMatchObject({
        ownerId,
        parentHostelId: mainId,
      });
    }
    expect(state.savedPayout).toEqual([]);
  });

  it("validates optional details when supplied", () => {
    expect(branchRequestSchema.safeParse(input({ panNumber: "123" })).success).toBe(
      false,
    );
    expect(
      branchRequestSchema.safeParse(
        input({ payoutAccount: { method: "BANK", holderName: "", number: "1" } }),
      ).success,
    ).toBe(false);
    expect(branchRequestSchema.safeParse(input({ contact: undefined })).success).toBe(
      false,
    );
  });

  it("rejects inactive plans", async () => {
    state.plan.status = "SUSPENDED";
    await expect(requestBranch(mainId.toString(), input(), principal)).rejects.toThrow(
      "plan has to be active",
    );
  });

  it("does not create anything when ownership is denied", async () => {
    const { resolveOwnedHostel } = await import("@/modules/billing/subscription-access");
    vi.mocked(resolveOwnedHostel).mockRejectedValueOnce(
      new Error("This hostel is not yours to manage."),
    );
    await expect(requestBranch(mainId.toString(), input(), principal)).rejects.toThrow(
      "not yours",
    );
    expect(hostels.docs).toHaveLength(1);
    expect(state.savedPayout).toEqual([]);
  });

  it("derives branch capacity from its own room setup", async () => {
    const result = await requestBranch(
      mainId.toString(),
      input({
        securityDeposit: 4000,
        roomConfigurations: [
          {
            roomType: "Twin",
            rooms: 3,
            bedsPerRoom: 2,
            vacantBeds: 6,
            mealInclusion: "Included",
          },
        ],
      }),
      principal,
    );
    expect(
      hostels.docs.find((doc) => String(doc._id) === result.branch.id)?.capacitySummary,
    ).toEqual({ totalRooms: 3, totalBeds: 6, vacantBeds: 6 });
    expect(
      hostels.docs.find((doc) => String(doc._id) === result.branch.id)?.securityDeposit,
    ).toBe(4000);
  });

  it("uses the global deposit for blank rows and preserves explicit zero overrides", async () => {
    const room = { rooms: 1, bedsPerRoom: 1, vacantBeds: 1, mealInclusion: "Included" };
    const result = await requestBranch(
      mainId.toString(),
      input({
        securityDeposit: 4000,
        roomConfigurations: [
          { ...room, roomType: "Single Room" },
          { ...room, roomType: "Single Room — Attached Bathroom", securityDeposit: 0 },
        ],
      }),
      principal,
    );
    const saved = hostels.docs.find((doc) => String(doc._id) === result.branch.id);
    expect(saved?.roomConfigurations).toMatchObject([
      { securityDeposit: 4000 },
      { securityDeposit: 0 },
    ]);
  });

  it("stops at the plan's cap, counting branches still pending", async () => {
    state.plan.maxBranches = 1;
    hostels.docs.push({
      _id: new Types.ObjectId(),
      parentHostelId: mainId,
      status: "PENDING_APPROVAL",
    });

    await expect(requestBranch(mainId.toString(), input(), principal)).rejects.toThrow(
      "includes 1 branch",
    );
  });

  it("refuses on a plan with no branches", async () => {
    state.plan = { maxBranches: 0, name: "Go", status: "ACTIVE" };

    await expect(requestBranch(mainId.toString(), input(), principal)).rejects.toThrow(
      "Go has none",
    );
  });
});
