import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What a resident is told when somebody edits their record.
 *
 * The rule under test is restraint: these fire for the two changes that alter
 * where somebody lives or whether they may stay, and for nothing else. Every
 * "stays quiet" case below is an edit that would otherwise have sent an alarming
 * notification about routine office work.
 */
const mocks = vi.hoisted(() => ({
  createNotification: vi.fn(),
  hostelName: vi.fn(),
}));

vi.mock("@/modules/notifications/notification.service", () => ({
  createInAppNotification: mocks.createNotification,
}));

vi.mock("@/modules/residents/resident-notify", () => ({
  getHostelName: mocks.hostelName,
}));

import {
  notifyResidentRoomChanged,
  notifyResidentStatusChanged,
} from "@/modules/residents/resident-changed-notify";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const userId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b1");

describe("notifyResidentRoomChanged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hostelName.mockResolvedValue("Everest Hostel");
  });

  it("names both the old and the new room type", async () => {
    await notifyResidentRoomChanged({
      hostelId,
      previous: { roomType: "FOUR_SHARING" },
      resident: { roomType: "SINGLE_ROOM", userId },
    });

    const call = mocks.createNotification.mock.calls[0][0];

    expect(call.title).toBe("Your room has changed");
    expect(call.body).toContain("Four Sharing Room");
    expect(call.body).toContain("Single Sitter Room");
    expect(call.category).toBe("ACCOUNT");
  });

  it("stays quiet when the room type did not move", async () => {
    await notifyResidentRoomChanged({
      hostelId,
      previous: { roomType: "FOUR_SHARING" },
      resident: { roomType: "FOUR_SHARING", userId },
    });

    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  /** A desk registration with no account has nowhere to receive this. */
  it("stays quiet for a resident with no linked account", async () => {
    await notifyResidentRoomChanged({
      hostelId,
      previous: { roomType: "FOUR_SHARING" },
      resident: { roomType: "SINGLE_ROOM", userId: null },
    });

    expect(mocks.createNotification).not.toHaveBeenCalled();
  });
});

describe("notifyResidentStatusChanged", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.hostelName.mockResolvedValue("Everest Hostel");
  });

  function change(status: string, previousStatus = "ACTIVE") {
    return notifyResidentStatusChanged({
      hostelId,
      previousStatus,
      resident: { userId },
      status,
    });
  }

  /**
   * The one that most needed saying: it can close somebody's access, and it was
   * reachable from a dropdown that told nobody.
   */
  it("sends a suspension at HIGH priority", async () => {
    await change("SUSPENDED");

    const call = mocks.createNotification.mock.calls[0][0];

    expect(call.title).toBe("Your stay is suspended");
    expect(call.priority).toBe("HIGH");
  });

  it("announces an admission", async () => {
    await change("ACTIVE", "PENDING");

    expect(mocks.createNotification.mock.calls[0][0].title).toBe("You are admitted");
  });

  it("announces a move-out", async () => {
    await change("MOVED_OUT");

    expect(mocks.createNotification.mock.calls[0][0].title).toBe("Your stay has ended");
  });

  /** An administrative reversal, not a state anybody experiences. */
  it("stays quiet for a move back to PENDING", async () => {
    await change("PENDING");

    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it("stays quiet when the status was re-saved unchanged", async () => {
    await change("ACTIVE", "ACTIVE");

    expect(mocks.createNotification).not.toHaveBeenCalled();
  });

  it("never lets a notification failure escape into the edit", async () => {
    mocks.createNotification.mockRejectedValue(new Error("mongo is down"));

    await expect(change("SUSPENDED")).resolves.toBeUndefined();
  });
});
