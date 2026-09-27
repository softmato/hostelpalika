import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

const mocks = vi.hoisted(() => ({
  applicationUpdateMany: vi.fn(),
  auditCreate: vi.fn(),
  connectToDatabase: vi.fn(),
  hostelFindById: vi.fn(),
  hostelFindOne: vi.fn(),
  hostelUpdateOne: vi.fn(),
  hostelFindOneAndUpdate: vi.fn(),
  issueTemporaryPasswordIfMissing: vi.fn(),
  subscriptionFindOne: vi.fn(),
  materializeRoomsFromConfigurations: vi.fn(),
  provisionCookAccount: vi.fn(),
  registerOrUpgradeUserByEmail: vi.fn(),
  sendEmail: vi.fn(),
  userFindOne: vi.fn(),
  userUpdateOne: vi.fn(),
  verificationFindOneAndUpdate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: mocks.connectToDatabase }));

vi.mock("@hostel/db/models/AuditLog", () => ({
  AuditLogModel: { create: mocks.auditCreate },
}));

vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: {
    findById: mocks.hostelFindById,
    findOne: mocks.hostelFindOne,
    findOneAndUpdate: mocks.hostelFindOneAndUpdate,
    updateOne: mocks.hostelUpdateOne,
  },
}));

vi.mock("@hostel/db/models/HostelApplication", () => ({
  HostelApplicationModel: { updateMany: mocks.applicationUpdateMany },
}));

/*
 * Approval reads the subscription for two things: the "you are verified" email
 * names the plan the owner chose while they were waiting, and whether the owner
 * gets the portal now depends on it — a public hostel that has not paid does
 * not. It is only ever read here — approval never writes billing state.
 */
vi.mock("@hostel/db/models/HostelSubscription", () => ({
  HostelSubscriptionModel: { findOne: mocks.subscriptionFindOne },
}));

vi.mock("@hostel/db/models/HostelVerification", () => ({
  HostelVerificationModel: { findOneAndUpdate: mocks.verificationFindOneAndUpdate },
}));

vi.mock("@hostel/db/models/HostelDocument", () => ({
  HostelDocumentModel: { find: vi.fn(), findOne: vi.fn(), updateMany: vi.fn() },
}));

vi.mock("@hostel/db/models/Inquiry", () => ({ InquiryModel: { find: vi.fn() } }));

vi.mock("@hostel/db/models/RatingReview", () => ({
  RatingReviewModel: { find: vi.fn() },
}));

vi.mock("@hostel/db/models/User", () => ({
  UserModel: { findOne: mocks.userFindOne, updateOne: mocks.userUpdateOne },
}));

vi.mock("@/modules/users/user.service", () => ({
  issueTemporaryPasswordIfMissing: mocks.issueTemporaryPasswordIfMissing,
  registerOrUpgradeUserByEmail: mocks.registerOrUpgradeUserByEmail,
}));

// Provisioning internals are covered in modules/food/cook.test.ts; here we pin
// the approval *wiring* — that approval issues a cook login and hands it to the
// owner in the approval email.
vi.mock("@/modules/food/cook.service", () => ({
  provisionCookAccount: mocks.provisionCookAccount,
}));

// Approval also builds the hostel's rooms from its registration details. That
// path has its own tests; here it only needs to stay out of the way.
vi.mock("@/modules/hostels/hostel-capacity.service", () => ({
  materializeRoomsFromConfigurations: mocks.materializeRoomsFromConfigurations,
}));

vi.mock("@hostel/shared/email/sender", () => ({ sendEmail: mocks.sendEmail }));

import { approvePlatformHostel } from "@/modules/hostels/hostel.service";

const hostelId = "64f0f0f0f0f0f0f0f0f0f0a1";
const ownerId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b1");

const platformPrincipal = {
  hostelIds: [],
  role: Role.SUPERADMIN,
  sessionId: "session-1",
  userId: "64f0f0f0f0f0f0f0f0f0f0a4",
};

function leanResult<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value) };
}

function queryResult<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
    select: vi.fn().mockReturnThis(),
    sort: vi.fn().mockReturnThis(),
  };
}

function hostelRecord() {
  return {
    _id: new Types.ObjectId(hostelId),
    name: "Sunrise Hostel",
    ownerId,
    slug: "sunrise-hostel",
    status: "APPROVED",
    verificationStatus: "VERIFIED",
  };
}

describe("hostel approval issues cook credentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hostelFindOneAndUpdate.mockReturnValue(leanResult(hostelRecord()));
    mocks.hostelFindOne.mockReturnValue(queryResult(hostelRecord()));
    // Not a branch unless a test says so.
    mocks.hostelFindById.mockReturnValue(queryResult({ parentHostelId: null }));
    mocks.hostelUpdateOne.mockResolvedValue({});
    // Paid before it was approved, so approval is what opens the portal.
    mocks.subscriptionFindOne.mockReturnValue(
      queryResult({ planName: null, source: "PUBLIC", status: "ACTIVE" }),
    );
    mocks.userFindOne.mockReturnValue(
      leanResult({ _id: ownerId, email: "owner@example.com", name: "Owner" }),
    );
    mocks.registerOrUpgradeUserByEmail.mockResolvedValue({ temporaryPassword: null });
    mocks.provisionCookAccount.mockResolvedValue({
      cookName: "Sunrise Hostel Cook",
      credentials: {
        email: "cook@sunrise-hostel.hostelpalika.local",
        temporaryPassword: "cook-secret-pw",
      },
      settings: {},
    });
    mocks.sendEmail.mockResolvedValue({ sent: true });
  });

  it("keeps the portal from a public hostel that has not paid", async () => {
    mocks.subscriptionFindOne.mockReturnValue(
      queryResult({ planName: "Starter", source: "PUBLIC", status: "SELECTED" }),
    );
    mocks.issueTemporaryPasswordIfMissing.mockResolvedValue({
      email: "owner@example.com",
      temporaryPassword: "public-temp-pw",
    });

    await approvePlatformHostel(hostelId, platformPrincipal);

    expect(mocks.registerOrUpgradeUserByEmail).not.toHaveBeenCalled();
    expect(mocks.provisionCookAccount).not.toHaveBeenCalled();
    expect(mocks.issueTemporaryPasswordIfMissing).toHaveBeenCalledWith(ownerId);

    // One email: verified, how to sign in and pay, and no admin or cook login.
    const html = mocks.sendEmail.mock.calls
      .map((call) => (call[0] as { html: string }).html)
      .join("\n");

    expect(mocks.sendEmail).toHaveBeenCalledTimes(1);
    expect(html).toContain("public-temp-pw");
    expect(html).toContain("Your hostel app opens after you pay.");
    expect(html).not.toContain("cook-secret-pw");
  });

  it("provisions the shared cook account during approval", async () => {
    await approvePlatformHostel(hostelId, platformPrincipal);

    expect(mocks.provisionCookAccount).toHaveBeenCalledWith(
      expect.objectContaining({
        hostelName: "Sunrise Hostel",
        hostelSlug: "sunrise-hostel",
      }),
    );
  });

  it("puts the cook credentials in the approval email", async () => {
    await approvePlatformHostel(hostelId, platformPrincipal);

    const email = mocks.sendEmail.mock.calls[0][0];
    expect(email.to).toBe("owner@example.com");
    expect(email.html).toContain("cook@sunrise-hostel.hostelpalika.local");
    expect(email.html).toContain("cook-secret-pw");
    expect(email.html).toContain("Cook login");
  });

  it("warns the owner that the cook login is shared and limited", async () => {
    await approvePlatformHostel(hostelId, platformPrincipal);

    const email = mocks.sendEmail.mock.calls[0][0];
    expect(email.html).toContain("kitchen login");
    expect(email.html).toContain("cannot see payments");
  });

  it("explains that the first cook sets the shared password", async () => {
    await approvePlatformHostel(hostelId, platformPrincipal);

    const email = mocks.sendEmail.mock.calls[0][0];
    expect(email.html).toContain("All cooks use that same password");
    expect(email.html).toContain("The first cook to log in sets a new password");
  });

  it("still approves when cook provisioning fails", async () => {
    mocks.provisionCookAccount.mockRejectedValue(new Error("cook upsert failed"));

    const result = await approvePlatformHostel(hostelId, platformPrincipal);

    expect(result.hostel.status).toBe("APPROVED");
    expect(mocks.sendEmail).toHaveBeenCalled();
    expect(mocks.sendEmail.mock.calls[0][0].html).not.toContain("Cook login");
  });

  it("lets only a superadmin approve a branch", async () => {
    mocks.hostelFindById.mockReturnValue(
      queryResult({ parentHostelId: new Types.ObjectId(), roomConfigurations: [] }),
    );

    await expect(
      approvePlatformHostel(hostelId, { ...platformPrincipal, role: Role.PLATFORM_MODERATOR }),
    ).rejects.toMatchObject({ errorCode: "BRANCH_NEEDS_SUPERADMIN" });
    expect(mocks.hostelFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it("publishes an approved branch and opens it to the owner, with no plan to pay", async () => {
    mocks.hostelFindById.mockReturnValue(
      queryResult({ parentHostelId: new Types.ObjectId(), roomConfigurations: [] }),
    );

    await approvePlatformHostel(hostelId, platformPrincipal);

    expect(mocks.hostelUpdateOne).toHaveBeenCalledWith(
      { _id: new Types.ObjectId(hostelId) },
      expect.objectContaining({ $set: expect.objectContaining({ status: "PUBLISHED" }) }),
    );
    expect(mocks.registerOrUpgradeUserByEmail).toHaveBeenCalledWith(
      expect.objectContaining({ hostelId, role: Role.HOSTEL_ADMIN }),
    );
    expect(mocks.provisionCookAccount).toHaveBeenCalled();
  });
});
