import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  notify: vi.fn(),
  resident: vi.fn(),
  rules: vi.fn(),
  staff: vi.fn(),
  updateOne: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/modules/finance/money-rules.service", () => ({ getMoneyRules: mocks.rules }));
vi.mock("@/modules/notifications/notification.service", () => ({ createInAppNotification: mocks.notify }));
vi.mock("@/modules/residents/resident-access", () => ({ findCurrentResident: mocks.resident }));
vi.mock("@/modules/residents/resident-notify", () => ({ resolveHostelStaffUserIds: mocks.staff }));
vi.mock("@hostel/db/models/Resident", () => ({ ResidentModel: { updateOne: mocks.updateOne } }));
vi.mock("@/lib/hostel-day", async (original) => ({
  ...(await original<object>()),
  hostelToday: () => new Date("2026-10-27T00:00:00.000Z"),
}));

import {
  cancelLeavingNotice,
  earliestLeavingDay,
  giveLeavingNotice,
} from "@/modules/move-checklist/leaving-notice.service";

const principal = { hostelIds: [], role: "RESIDENT", sessionId: "s", userId: "64f0f0f0f0f0f0f0f0f0f0f9" } as never;
const resident = {
  _id: new Types.ObjectId(),
  firstName: "Asha",
  hostelId: new Types.ObjectId(),
  lastName: "Rai",
};

describe("move-out notice (field review E5)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.rules.mockResolvedValue({ moveOutNoticeDays: 7 });
    mocks.resident.mockResolvedValue(resident);
    mocks.staff.mockResolvedValue(["admin", "warden"]);
    mocks.notify.mockResolvedValue(undefined);
  });

  it("counts the notice from today", () => {
    expect(earliestLeavingDay(new Date("2026-10-27T00:00:00.000Z"), 7).toISOString().slice(0, 10)).toBe("2026-11-03");
  });

  it("refuses a day inside the notice, on the server", async () => {
    await expect(giveLeavingNotice(principal, { date: "2026-11-02" })).rejects.toMatchObject({
      errorCode: "LEAVING_TOO_SOON",
      status: 400,
    });
    expect(mocks.updateOne).not.toHaveBeenCalled();
  });

  it("stops the rent on the day and tells admin and wardens at once", async () => {
    await giveLeavingNotice(principal, { date: "2026-11-03", reason: "Going home" });

    expect(mocks.updateOne).toHaveBeenCalledWith(
      { _id: resident._id },
      {
        $set: expect.objectContaining({
          lastMonthCharge: "TILL_DAY",
          leavingOn: new Date("2026-11-03T00:00:00.000Z"),
          moveOutDate: new Date("2026-11-03T00:00:00.000Z"),
        }),
      },
    );
    expect(mocks.notify).toHaveBeenCalledTimes(2);
  });

  it("cancelling clears the day and the fee stop", async () => {
    mocks.resident.mockResolvedValue({ ...resident, leavingOn: new Date("2026-11-03T00:00:00.000Z") });

    await cancelLeavingNotice(principal);

    expect(mocks.updateOne).toHaveBeenCalledWith(
      { _id: resident._id },
      { $set: { lastMonthCharge: null, leavingOn: null, leavingReason: null, moveOutDate: null } },
    );
  });
});
