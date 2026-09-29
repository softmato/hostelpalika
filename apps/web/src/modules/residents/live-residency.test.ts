import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  demoteToPublicAccount: vi.fn(),
  residentExists: vi.fn(),
  residentFind: vi.fn(),
  userUpdateOne: vi.fn(),
}));

vi.mock("@/modules/auth/auth.service", () => ({
  demoteToPublicAccount: mocks.demoteToPublicAccount,
}));
vi.mock("@hostel/db/models/Hostel", () => ({ HostelModel: { findById: vi.fn() } }));
vi.mock("@hostel/db/models/Resident", () => ({
  ResidentModel: { exists: mocks.residentExists, find: mocks.residentFind },
}));
vi.mock("@hostel/db/models/User", () => ({
  UserModel: { updateOne: mocks.userUpdateOne },
}));

import {
  DEMO_RESIDENT_EMAIL,
  findLiveResidency,
  releaseResidentAccount,
} from "@/modules/residents/live-residency";

const userId = new Types.ObjectId();
const hostelId = new Types.ObjectId();

describe("releaseResidentAccount", () => {
  beforeEach(() => vi.clearAllMocks());

  it("hands a moved-out resident who lives nowhere back a public account", async () => {
    mocks.residentExists.mockResolvedValue(null);

    await releaseResidentAccount(userId, hostelId);

    expect(mocks.userUpdateOne).toHaveBeenCalledWith(
      { _id: userId },
      { $pull: { hostelIds: hostelId } },
    );
    expect(mocks.demoteToPublicAccount).toHaveBeenCalledWith(userId);
  });

  it("only takes this hostel away from somebody who still lives elsewhere", async () => {
    mocks.residentExists.mockResolvedValue({ _id: new Types.ObjectId() });

    await releaseResidentAccount(userId, hostelId);

    expect(mocks.userUpdateOne).toHaveBeenCalledTimes(1);
    expect(mocks.demoteToPublicAccount).not.toHaveBeenCalled();
  });
});

describe("the demo resident", () => {
  it("never lives elsewhere, so any hostel can register it", async () => {
    await expect(
      findLiveResidency({ emails: [DEMO_RESIDENT_EMAIL.toUpperCase()], userIds: [userId] }),
    ).resolves.toBeNull();
    expect(mocks.residentFind).not.toHaveBeenCalled();
  });
});
