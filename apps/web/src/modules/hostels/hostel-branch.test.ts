import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

import type { FakeModel } from "../../../test/fake-mongo";

const state = vi.hoisted(() => ({
  plan: { maxBranches: 3, name: "Max", status: "ACTIVE" },
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
vi.mock("@hostel/db/models/HostelDocument", fake("HostelDocumentModel"));
vi.mock("@hostel/db/models/User", fake("UserModel"));
vi.mock("@/modules/billing/subscription-access", () => ({
  resolveOwnedHostel: vi.fn(async (hostelId: string) => ({
    _id: new Types.ObjectId(hostelId),
    name: "Main",
  })),
}));
// The allowance reads the main hostel's subscription row itself (`branchPlan`).
vi.mock("@hostel/db/models/HostelSubscription", () => ({
  HostelSubscriptionModel: {
    findOne: () => ({
      select: () => ({
        lean: async () => ({ planId: "max", planName: state.plan.name, status: state.plan.status }),
      }),
    }),
  },
}));
vi.mock("@/modules/platform-config/site-config.service", () => ({
  getSiteConfigSection: vi.fn(async () => ({
    plans: [{ id: "max", maxBranches: state.plan.maxBranches, name: state.plan.name }],
  })),
}));

const { requestBranch, branchRequestSchema, getBranchDetails } = await import("./hostel-branch.service");
const { HostelModel } = await import("@hostel/db/models/Hostel");
const { HostelDocumentModel } = await import("@hostel/db/models/HostelDocument");
const documents = HostelDocumentModel as unknown as FakeModel;
const users = (await import("@hostel/db/models/User")).UserModel as unknown as FakeModel;

const hostels = HostelModel as unknown as FakeModel;
const mainId = new Types.ObjectId();
const ownerId = new Types.ObjectId();
const principal = {
  hostelIds: [mainId.toString()],
  role: Role.HOSTEL_ADMIN,
  userId: ownerId.toString(),
};
const input = { branchLabel: "Block B", name: "Study Sanjal" };

beforeEach(() => {
  documents.reset([]);
  users.reset([{ _id: ownerId, hostelIds: [mainId] }]);
  state.plan = { maxBranches: 3, name: "Max", status: "ACTIVE" };
  hostels.reset([
    {
      _id: mainId,
      contact: { email: "owner@example.com", phone: "9811111111" },
      location: { area: "Baneshwor" },
      name: "Study Sanjal",
      ownerId,
      parentHostelId: null,
      slug: "study-sanjal",
      status: "PUBLISHED",
    },
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
  it("opens a DRAFT branch whose own KYC carries the rest, like a quick sign-up", async () => {
    const result = await requestBranch(mainId.toString(), input, principal);
    const saved = hostels.docs.find((doc) => String(doc._id) === result.branch.id);

    expect(result.branch).toMatchObject({ name: "Study Sanjal", status: "DRAFT" });
    expect(saved).toMatchObject({
      branchLabel: "Block B",
      contact: { email: "owner@example.com", phone: "9811111111" },
      kyc: { required: true, status: "DRAFT" },
      ownerId,
      parentHostelId: mainId,
      status: "DRAFT",
      verificationStatus: "UNVERIFIED",
    });
    // The owner can open it at once: its KYC is done from inside it.
    expect((users.docs[0].hostelIds as unknown[]).map(String)).toEqual([String(mainId), result.branch.id]);
    // The main hostel's slug is taken: the branch gets its own.
    expect(saved?.slug).toBe("study-sanjal-2");
  });

  it("rejects inactive plans", async () => {
    state.plan.status = "SUSPENDED";
    await expect(requestBranch(mainId.toString(), input, principal)).rejects.toThrow(
      "plan has to be active",
    );
  });

  it("does not create anything when ownership is denied", async () => {
    const { resolveOwnedHostel } = await import("@/modules/billing/subscription-access");
    vi.mocked(resolveOwnedHostel).mockRejectedValueOnce(
      new Error("This hostel is not yours to manage."),
    );
    await expect(requestBranch(mainId.toString(), input, principal)).rejects.toThrow(
      "not yours",
    );
    expect(hostels.docs).toHaveLength(1);
  });

  it("stops at the plan's cap, counting branches still in KYC", async () => {
    state.plan.maxBranches = 1;
    hostels.docs.push({ _id: new Types.ObjectId(), parentHostelId: mainId, status: "DRAFT" });

    await expect(requestBranch(mainId.toString(), input, principal)).rejects.toThrow(
      "includes 1 branch",
    );
  });

  it("refuses on a plan with no branches", async () => {
    state.plan = { maxBranches: 0, name: "Go", status: "ACTIVE" };

    await expect(requestBranch(mainId.toString(), input, principal)).rejects.toThrow(
      "Go has none",
    );
  });

  it("asks for the name and the label, nothing else", () => {
    expect(branchRequestSchema.safeParse({ name: "Study Sanjal" }).success).toBe(false);
    expect(branchRequestSchema.safeParse({ branchLabel: "  ", name: "Study Sanjal" }).success).toBe(false);
    expect(branchRequestSchema.safeParse({ branchLabel: "B".repeat(41), name: "Study Sanjal" }).success).toBe(false);
    expect(branchRequestSchema.parse({ branchLabel: " Block B ", name: " Study Sanjal ", roomConfigurations: [] })).toEqual(input);
  });
});
