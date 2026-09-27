import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

/**
 * A complaint's voice note has to be the complainant's own recording. Checking
 * the hostel alone let a resident name a neighbour's recording by id and file
 * it — someone else's voice on their complaint.
 */
const mocks = vi.hoisted(() => ({
  assetFindOne: vi.fn(),
  complaintCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));

vi.mock("@hostel/db/models/FileAsset", () => ({
  FileAssetModel: { findOne: mocks.assetFindOne },
}));

vi.mock("@hostel/db/models/Complaint", () => ({
  ComplaintModel: { create: mocks.complaintCreate },
}));

vi.mock("@/modules/platform-config/operations-config", () => ({
  getOperationsConfig: vi.fn().mockResolvedValue({ complaintSlaHours: 48 }),
}));

vi.mock("@/modules/residents/resident-access", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  findCurrentResident: vi.fn().mockResolvedValue({
    _id: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0c1"),
    hostelId: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1"),
  }),
}));

import { createComplaint } from "@/modules/complaints/complaint.service";

const residentUserId = "64f0f0f0f0f0f0f0f0f0f0d1";
const principal = {
  hostelIds: ["64f0f0f0f0f0f0f0f0f0f0a1"],
  role: Role.RESIDENT,
  userId: residentUserId,
};

function recording(ownerId: string) {
  return {
    lean: async () => ({
      _id: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0e1"),
      hostelId: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1"),
      kind: "COMPLAINT_NOTE",
      mimeType: "audio/m4a",
      ownerId: new Types.ObjectId(ownerId),
      uploadCompletedAt: new Date(),
    }),
  };
}

describe("createComplaint — the voice note", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses a recording another resident made", async () => {
    mocks.assetFindOne.mockReturnValue(recording("64f0f0f0f0f0f0f0f0f0f0d9"));

    await expect(
      createComplaint(
        {
          category: "OTHER",
          description: "Noise at night",
          voiceNoteAssetId: "64f0f0f0f0f0f0f0f0f0f0e1",
        } as never,
        principal,
      ),
    ).rejects.toMatchObject({ errorCode: "VOICE_NOTE_NOT_FOUND", status: 404 });
    expect(mocks.complaintCreate).not.toHaveBeenCalled();
  });
});
