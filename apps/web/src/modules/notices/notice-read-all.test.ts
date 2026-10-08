import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bulkWrite: vi.fn(),
  noticeDistinct: vi.fn(),
  readDistinct: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@hostel/db/models/AuditLog", () => ({ AuditLogModel: {} }));
vi.mock("@hostel/db/models/Notice", () => ({
  NoticeModel: { distinct: mocks.noticeDistinct },
}));
vi.mock("@hostel/db/models/NoticeReadStatus", () => ({
  NoticeReadStatusModel: { bulkWrite: mocks.bulkWrite, distinct: mocks.readDistinct },
}));
vi.mock("@/lib/realtime/server", () => ({ publishResourceChange: vi.fn() }));
vi.mock("@/modules/notifications/notification.service", () => ({
  createInAppNotification: vi.fn(),
}));
vi.mock("@/modules/platform-config/operations-config", () => ({ getOperationsConfig: vi.fn() }));
vi.mock("@/modules/residents/resident-notify", () => ({}));
vi.mock(import("@/modules/residents/resident-access"), async (importOriginal) => ({
  ...(await importOriginal()),
  findCurrentResident: vi.fn().mockResolvedValue({ hostelId: new Types.ObjectId() }),
}));

import { markAllNoticesAsRead } from "@/modules/notices/notice.service";

const principal = { userId: new Types.ObjectId().toString() } as never;

/** Opening the board clears the Notices badge — and writes only what is missing. */
describe("markAllNoticesAsRead", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes a read row for each notice not yet read, and only those", async () => {
    const [seen, fresh, other] = [new Types.ObjectId(), new Types.ObjectId(), new Types.ObjectId()];
    mocks.noticeDistinct.mockResolvedValue([seen, fresh, other]);
    mocks.readDistinct.mockResolvedValue([seen]);

    await expect(markAllNoticesAsRead(principal)).resolves.toEqual({ marked: 2 });

    const ops = mocks.bulkWrite.mock.calls[0][0] as { updateOne: { filter: { noticeId: unknown } } }[];
    expect(ops.map((op) => op.updateOne.filter.noticeId)).toEqual([fresh, other]);
  });

  it("writes nothing when everything is read", async () => {
    const id = new Types.ObjectId();
    mocks.noticeDistinct.mockResolvedValue([id]);
    mocks.readDistinct.mockResolvedValue([id]);

    await expect(markAllNoticesAsRead(principal)).resolves.toEqual({ marked: 0 });
    expect(mocks.bulkWrite).not.toHaveBeenCalled();
  });

  it("treats a duplicate from a concurrent call as done", async () => {
    mocks.noticeDistinct.mockResolvedValue([new Types.ObjectId()]);
    mocks.readDistinct.mockResolvedValue([]);
    mocks.bulkWrite.mockRejectedValue(Object.assign(new Error("dup"), { code: 11000 }));

    await expect(markAllNoticesAsRead(principal)).resolves.toEqual({ marked: 1 });
  });
});
