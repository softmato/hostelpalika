import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attendanceDeleteMany: vi.fn(),
  auditCreate: vi.fn().mockResolvedValue({}),
  commentUpdateMany: vi.fn(),
  connectToDatabase: vi.fn(),
  consentDeleteMany: vi.fn(),
  deletionFind: vi.fn(),
  deletionUpdateOne: vi.fn(),
  deviceTokenDeleteMany: vi.fn(),
  fileAssetUpdateMany: vi.fn(),
  notificationDeleteMany: vi.fn(),
  postUpdateMany: vi.fn(),
  questionCallDeleteMany: vi.fn(),
  residentDeleteMany: vi.fn(),
  residentFind: vi.fn(),
  sessionDeleteMany: vi.fn(),
  userDeleteOne: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: mocks.connectToDatabase }));

vi.mock("@hostel/db/models/AccountDeletionRequest", () => ({
  AccountDeletionRequestModel: {
    find: mocks.deletionFind,
    updateOne: mocks.deletionUpdateOne,
  },
}));

vi.mock("@hostel/db/models/AttendanceLog", () => ({
  AttendanceLogModel: { deleteMany: mocks.attendanceDeleteMany },
}));
vi.mock("@hostel/db/models/AuditLog", () => ({
  AuditLogModel: { create: mocks.auditCreate },
}));
vi.mock("@hostel/db/models/CommunityComment", () => ({
  CommunityCommentModel: { updateMany: mocks.commentUpdateMany },
}));
vi.mock("@hostel/db/models/CommunityPost", () => ({
  CommunityPostModel: { updateMany: mocks.postUpdateMany },
}));
vi.mock("@hostel/db/models/ConsentLog", () => ({
  ConsentLogModel: { deleteMany: mocks.consentDeleteMany },
}));
vi.mock("@hostel/db/models/DeviceToken", () => ({
  DeviceTokenModel: { deleteMany: mocks.deviceTokenDeleteMany },
}));
vi.mock("@hostel/db/models/FileAsset", () => ({
  FileAssetModel: { updateMany: mocks.fileAssetUpdateMany },
}));
vi.mock("@hostel/db/models/Notification", () => ({
  NotificationModel: { deleteMany: mocks.notificationDeleteMany },
}));
vi.mock("@hostel/db/models/QuestionCallClick", () => ({
  QuestionCallClickModel: { deleteMany: mocks.questionCallDeleteMany },
}));
vi.mock("@hostel/db/models/Resident", () => ({
  ResidentModel: { deleteMany: mocks.residentDeleteMany, find: mocks.residentFind },
}));
vi.mock("@hostel/db/models/Session", () => ({
  SessionModel: { deleteMany: mocks.sessionDeleteMany },
}));
vi.mock("@hostel/db/models/User", () => ({
  UserModel: { deleteOne: mocks.userDeleteOne },
}));

import {
  purgeAccount,
  runAccountDeletionPurge,
} from "@/modules/users/account-purge.service";

const userId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0ee01");
const residentId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0ee02");

function selectResult<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value), select: vi.fn().mockReturnThis() };
}

function queryResult<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value), limit: vi.fn().mockReturnThis() };
}

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks resets call history but not implementations, so a rejection
  // set by one test would otherwise leak into the next.
  mocks.auditCreate.mockResolvedValue({});
  mocks.userDeleteOne.mockResolvedValue({});
  mocks.residentFind.mockReturnValue(selectResult([{ _id: residentId }]));
  mocks.deletionFind.mockReturnValue(queryResult([]));
  mocks.fileAssetUpdateMany.mockResolvedValue({ modifiedCount: 0 });
});

/**
 * Plan item 0.3: a presign never followed by a PUT leaves an ACTIVE FileAsset
 * row pointing at bytes that do not exist (current §7.10). The sweep rides
 * along with this daily job rather than taking a cron slot of its own.
 */
describe("runAccountDeletionPurge — abandoned uploads", () => {
  const now = new Date("2026-09-01T00:00:00.000Z");

  it("marks day-old uncompleted uploads deleted", async () => {
    mocks.fileAssetUpdateMany.mockResolvedValue({ modifiedCount: 3 });

    const result = await runAccountDeletionPurge(now);

    expect(result.abandonedUploads).toBe(3);

    const [filter, update] = mocks.fileAssetUpdateMany.mock.calls[0];
    expect(filter.uploadCompletedAt).toEqual({ $exists: false });
    expect(filter.status).toBe("ACTIVE");
    expect(filter.createdAt.$lt).toEqual(new Date("2026-08-31T00:00:00.000Z"));
    expect(update).toEqual({
      $set: { deletedAt: now, isDeleted: true, status: "DELETED" },
    });
  });

  // Without the epoch floor the first run would delete every file the product
  // has ever stored, since none of them carry the new field.
  it("never touches assets created before upload verification shipped", async () => {
    await runAccountDeletionPurge(now);

    const [filter] = mocks.fileAssetUpdateMany.mock.calls[0];
    expect(filter.createdAt.$gt).toEqual(new Date("2026-08-06T00:00:00.000Z"));
  });

  it("leaves a completed upload alone however old it is", async () => {
    await runAccountDeletionPurge(now);

    const [filter] = mocks.fileAssetUpdateMany.mock.calls[0];
    expect(filter.uploadCompletedAt).toEqual({ $exists: false });
  });
});

describe("purgeAccount — what is erased", () => {
  it("erases the data that is about the person", async () => {
    await purgeAccount(userId);

    expect(mocks.attendanceDeleteMany).toHaveBeenCalledWith({ userId });
    expect(mocks.consentDeleteMany).toHaveBeenCalledWith({ userId });
    expect(mocks.deviceTokenDeleteMany).toHaveBeenCalledWith({ userId });
    expect(mocks.notificationDeleteMany).toHaveBeenCalledWith({ userId });
    expect(mocks.questionCallDeleteMany).toHaveBeenCalledWith({ userId });
    expect(mocks.sessionDeleteMany).toHaveBeenCalledWith({ userId });
    expect(mocks.residentDeleteMany).toHaveBeenCalledWith({ userId });
    expect(mocks.userDeleteOne).toHaveBeenCalledWith({ _id: userId });
  });

  it("deletes location history keyed by resident as well as by user", async () => {
    // AttendanceLog carries both ids; matching on only one would leave rows.
    await purgeAccount(userId);

    expect(mocks.attendanceDeleteMany).toHaveBeenCalledWith({
      residentId: { $in: [residentId] },
    });
  });

  it("keeps community content but cuts the authorship link", async () => {
    await purgeAccount(userId);

    for (const updateMany of [mocks.postUpdateMany, mocks.commentUpdateMany]) {
      expect(updateMany).toHaveBeenCalledWith(
        { authorId: userId },
        { $set: { authorId: null, isAnonymous: true } },
      );
    }
  });

  it("records the erasure itself in the audit log", async () => {
    // The audit trail is the only evidence the request was honoured, so it is
    // deliberately not erased with everything else.
    await purgeAccount(userId);

    expect(mocks.auditCreate.mock.calls[0][0]).toMatchObject({
      action: "ACCOUNT_PURGED",
      actorType: "SYSTEM",
      entityId: String(userId),
      entityType: "User",

    });
  });
});

describe("runAccountDeletionPurge — which requests are due", () => {
  it("only sweeps requests with a schedule that has passed", async () => {
    const now = new Date("2030-03-01T00:00:00.000Z");

    await runAccountDeletionPurge(now);

    const filter = mocks.deletionFind.mock.calls[0][0];
    expect(filter.cancelled).toBe(false);
    expect(filter.executed).toBe(false);
    // A PLATFORM_REVIEW request awaiting approval has no scheduledDeletionAt,
    // so it can never be swept up here by accident.
    expect(filter.scheduledDeletionAt).toEqual({ $lte: now, $ne: null });
  });

  it("marks a request executed only after the purge succeeded", async () => {
    mocks.deletionFind.mockReturnValue(
      queryResult([{ _id: new Types.ObjectId(), userId }]),
    );

    const result = await runAccountDeletionPurge();

    expect(result).toMatchObject({ due: 1, failed: 0, purged: 1 });
    expect(mocks.deletionUpdateOne.mock.calls[0][1].$set.executed).toBe(true);
  });

  it("leaves the request due when the purge throws, so the next run retries", async () => {
    mocks.deletionFind.mockReturnValue(
      queryResult([{ _id: new Types.ObjectId(), userId }]),
    );
    mocks.userDeleteOne.mockRejectedValue(new Error("mongo down"));

    const result = await runAccountDeletionPurge();

    expect(result).toMatchObject({ due: 1, failed: 1, purged: 0 });
    expect(mocks.deletionUpdateOne).not.toHaveBeenCalled();
  });

  it("does not strand the rest of the batch when one account fails", async () => {
    const otherUserId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0ee03");
    mocks.deletionFind.mockReturnValue(
      queryResult([
        { _id: new Types.ObjectId(), userId },
        { _id: new Types.ObjectId(), userId: otherUserId },
      ]),
    );
    mocks.userDeleteOne.mockRejectedValueOnce(new Error("mongo down"));

    const result = await runAccountDeletionPurge();

    expect(result).toMatchObject({ due: 2, failed: 1, purged: 1 });
  });
});
