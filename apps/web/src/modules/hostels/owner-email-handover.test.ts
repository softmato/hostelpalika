import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

const m = vi.hoisted(() => ({
  applicationUpdateMany: vi.fn(),
  documentFind: vi.fn(),
  documentUpdateMany: vi.fn(),
  fileUpdateMany: vi.fn(),
  hostelFind: vi.fn(),
  hostelFindOne: vi.fn(),
  hostelUpdateMany: vi.fn(),
  oauthDeleteMany: vi.fn(),
  registerOrUpgradeUserByEmail: vi.fn(),
  sendEmail: vi.fn(),
  sessionExists: vi.fn(),
  sessionUpdateMany: vi.fn(),
  userFindById: vi.fn(),
  userFindOne: vi.fn(),
  userUpdateOne: vi.fn(),
}));

function query<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value), select: vi.fn().mockReturnThis() };
}

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@hostel/db/models/AuditLog", () => ({ AuditLogModel: { create: vi.fn() } }));
vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: { find: m.hostelFind, findOne: m.hostelFindOne, updateMany: m.hostelUpdateMany },
}));
vi.mock("@hostel/db/models/HostelApplication", () => ({
  HostelApplicationModel: { updateMany: m.applicationUpdateMany },
}));
vi.mock("@hostel/db/models/HostelDocument", () => ({
  HostelDocumentModel: { find: m.documentFind, updateMany: m.documentUpdateMany },
}));
vi.mock("@hostel/db/models/FileAsset", () => ({ FileAssetModel: { updateMany: m.fileUpdateMany } }));
vi.mock("@hostel/db/models/OAuthAccount", () => ({ OAuthAccountModel: { deleteMany: m.oauthDeleteMany } }));
vi.mock("@hostel/db/models/Session", () => ({
  SessionModel: { exists: m.sessionExists, updateMany: m.sessionUpdateMany },
}));
vi.mock("@hostel/db/models/User", () => ({
  UserModel: { findById: m.userFindById, findOne: m.userFindOne, updateOne: m.userUpdateOne },
}));
vi.mock("@hostel/shared/email/sender", () => ({ sendEmail: m.sendEmail }));
vi.mock("@/modules/users/user.service", () => ({
  issueTemporaryPasswordIfMissing: vi.fn(),
  registerOrUpgradeUserByEmail: m.registerOrUpgradeUserByEmail,
}));

import { updateHostelOwnerEmail } from "@/modules/hostels/hostel.service";

const hostelId = new Types.ObjectId();
const typoOwnerId = new Types.ObjectId();
const realAccountId = new Types.ObjectId();
const principal = { hostelIds: [], role: Role.SUPERADMIN, sessionId: "s", userId: new Types.ObjectId().toString() };

describe("correcting an owner email onto an existing account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    m.hostelFindOne.mockReturnValue(query({ _id: hostelId, name: "Alsus Boys Hostel", ownerId: typoOwnerId }));
    m.hostelFind.mockReturnValue(query([{ _id: hostelId, name: "Alsus Boys Hostel" }]));
    m.documentFind.mockReturnValue(query([{ fileAssetId: new Types.ObjectId() }]));
    m.userFindById.mockReturnValue(
      query({ email: "typo@gmail.com", hostelIds: [hostelId], role: Role.HOSTEL_ADMIN }),
    );
    m.sessionExists.mockResolvedValue(null);
    m.registerOrUpgradeUserByEmail.mockResolvedValue({ temporaryPassword: "Tmp-Pass-123" });
    m.sendEmail.mockResolvedValue({ sent: true });
  });

  it("moves the hostel to the real public account and retires the unused typo account", async () => {
    m.userFindOne
      .mockReturnValueOnce(query({ _id: typoOwnerId, email: "typo@gmail.com" }))
      .mockReturnValueOnce(query({ _id: realAccountId, role: Role.PUBLIC }));

    const result = await updateHostelOwnerEmail(hostelId.toString(), "Real@Gmail.com", principal);

    expect(result).toMatchObject({
      changed: true,
      email: "real@gmail.com",
      notification: { google: true, loginIssued: false, sent: true },
      ownerId: realAccountId.toString(),
    });
    expect(m.registerOrUpgradeUserByEmail).toHaveBeenCalledWith(
      expect.objectContaining({ role: Role.HOSTEL_ADMIN, userId: realAccountId.toString() }),
    );
    expect(m.hostelUpdateMany).toHaveBeenCalledWith(
      { ownerId: typoOwnerId },
      { $set: { ownerId: realAccountId } },
    );
    expect(m.applicationUpdateMany).toHaveBeenCalled();
    expect(m.documentUpdateMany).toHaveBeenCalled();
    const [filter, update] = m.userUpdateOne.mock.calls.at(-1)!;
    expect(filter).toEqual({ _id: typoOwnerId });
    expect(update.$set).toMatchObject({ hostelIds: [], isDeleted: true, role: Role.PUBLIC });
    expect(update.$unset).toMatchObject({ passwordHash: "" });
    expect(m.sessionUpdateMany).toHaveBeenCalled();

    // Both inboxes are told, each naming the other. A Gmail is sent to Google, never a password.
    const mails = new Map(m.sendEmail.mock.calls.map(([mail]) => [mail.to, mail.html as string]));
    expect([...mails.keys()].sort()).toEqual(["real@gmail.com", "typo@gmail.com"]);
    expect(mails.get("real@gmail.com")).toContain("Continue with Google");
    expect(mails.get("real@gmail.com")).toContain("typo@gmail.com");
    expect(mails.get("real@gmail.com")).not.toContain("Tmp-Pass-123");
    expect(mails.get("typo@gmail.com")).toContain("real@gmail.com");
    expect(mails.get("typo@gmail.com")).not.toContain("Tmp-Pass-123");
  });

  it("mails the temporary password to an address Google can't sign in", async () => {
    m.userFindOne
      .mockReturnValueOnce(query({ _id: typoOwnerId, email: "typo@gmail.com" }))
      .mockReturnValueOnce(query({ _id: realAccountId, role: Role.PUBLIC }));

    await updateHostelOwnerEmail(hostelId.toString(), "owner@hostel.com.np", principal);

    const mails = new Map(m.sendEmail.mock.calls.map(([mail]) => [mail.to, mail.html as string]));
    expect(mails.get("owner@hostel.com.np")).toContain("Tmp-Pass-123");
    expect(mails.get("typo@gmail.com")).not.toContain("Tmp-Pass-123");
  });

  it("refuses an address that signs in as a resident", async () => {
    m.userFindOne
      .mockReturnValueOnce(query({ _id: typoOwnerId, email: "typo@gmail.com" }))
      .mockReturnValueOnce(query({ _id: realAccountId, role: Role.RESIDENT }));

    await expect(
      updateHostelOwnerEmail(hostelId.toString(), "real@gmail.com", principal),
    ).rejects.toMatchObject({ status: 409 });
    expect(m.hostelUpdateMany).not.toHaveBeenCalled();
  });
});
