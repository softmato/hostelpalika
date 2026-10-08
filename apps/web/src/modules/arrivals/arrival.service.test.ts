import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(),
  notify: vi.fn(),
  staff: vi.fn(),
}));

const hostelId = new Types.ObjectId();

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@hostel/db/models/Hostel", () => ({
  HostelModel: {
    findOne: () => ({ select: () => ({ lean: async () => ({ _id: hostelId, name: "Sunrise" }) }) }),
  },
}));
vi.mock("@hostel/db/models/Notification", () => ({ NotificationModel: { exists: mocks.exists } }));
vi.mock("@hostel/db/models/User", () => ({
  UserModel: { findById: () => ({ select: () => ({ lean: async () => ({ name: "Asha" }) }) }) },
}));
vi.mock("@/modules/notifications/notification.service", () => ({
  createInAppNotification: mocks.notify,
}));
vi.mock("@/modules/residents/resident-notify", () => ({ resolveHostelStaffUserIds: mocks.staff }));

import { announceArrival } from "@/modules/arrivals/arrival.service";

const traveller = new Types.ObjectId().toString();
const owner = new Types.ObjectId().toString();
const principal = { userId: traveller } as never;

describe("announceArrival", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.staff.mockResolvedValue([owner, traveller]);
    mocks.exists.mockResolvedValue(null);
  });

  it("tells the staff, not the traveller, and sends no position", async () => {
    await expect(announceArrival("sunrise", { minutes: 8, mode: "foot" }, principal)).resolves.toEqual({
      sent: true,
    });

    expect(mocks.notify).toHaveBeenCalledTimes(1);
    const row = mocks.notify.mock.calls[0][0];
    expect(row.userId).toBe(owner);
    expect(row.body).toContain("about 8 min");
    expect(Object.keys(row.data).sort()).toEqual(["minutes", "mode", "travellerId"]);
  });

  it("does nothing again inside the ten-minute window", async () => {
    mocks.exists.mockResolvedValue({ _id: new Types.ObjectId() });

    await announceArrival("sunrise", { minutes: 8, mode: "car" }, principal);
    expect(mocks.notify).not.toHaveBeenCalled();
  });
});
