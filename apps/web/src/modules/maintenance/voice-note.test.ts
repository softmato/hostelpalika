import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";

/**
 * The voice note's four refusals.
 *
 * Each one is a way an attached recording could go wrong *quietly* — a play
 * button that does nothing, another hostel's audio, or a payment proof handed
 * to a contractor — so what is asserted is that the request is refused rather
 * than raised with the id silently dropped.
 */
const mocks = vi.hoisted(() => ({
  assetFindOne: vi.fn(),
  auditCreate: vi.fn(),
  connectToDatabase: vi.fn(),
  historyCreate: vi.fn(),
  providerFindOne: vi.fn(),
  requestCreate: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: mocks.connectToDatabase }));

vi.mock("@/lib/realtime/server", () => ({ publishResourceChange: vi.fn() }));

vi.mock("@hostel/db/models/AuditLog", () => ({
  AuditLogModel: { create: mocks.auditCreate },
}));

vi.mock("@hostel/db/models/FileAsset", () => ({
  FileAssetModel: { findOne: mocks.assetFindOne },
}));

vi.mock("@hostel/db/models/HostelSettings", () => ({
  HostelSettingsModel: {
    findOne: () => ({ select: () => ({ lean: async () => null }) }),
    updateOne: vi.fn(),
  },
}));

vi.mock("@hostel/db/models/MaintenanceComment", () => ({
  MaintenanceCommentModel: { create: vi.fn(), find: vi.fn() },
}));

vi.mock("@hostel/db/models/MaintenanceHistory", () => ({
  MaintenanceHistoryModel: { create: mocks.historyCreate, find: vi.fn() },
}));

vi.mock("@hostel/db/models/MaintenanceRequest", () => ({
  MaintenanceRequestModel: { create: mocks.requestCreate, find: vi.fn() },
}));

vi.mock("@hostel/db/models/ServiceProvider", () => ({
  ServiceProviderModel: { findOne: mocks.providerFindOne },
}));

// Call-out minimums are platform config; unmocked, the read waits on Mongo.
vi.mock("@/modules/platform-config/operations-config", () => ({
  DEFAULT_MINIMUM_CHARGE: 200,
  getOperationsConfig: vi.fn(async () => ({ maintenanceMinimumCharges: {} })),
}));

// This file is about the voice note, not about who is told a job was raised.
vi.mock("@/modules/maintenance/maintenance-notify", () => ({
  notifyProviderOfAssignment: vi.fn(),
  notifyProviderOfMaintenanceNote: vi.fn(),
  notifyProviderOfStatusChange: vi.fn(),
  notifyStaffOfJobProgress: vi.fn(),
  notifyStaffOfNewMaintenanceRequest: vi.fn(),
}));

import { createMaintenanceRequest } from "@/modules/maintenance/maintenance.service";

const hostelId = "64f0f0f0f0f0f0f0f0f0f0f1";
const otherHostelId = "64f0f0f0f0f0f0f0f0f0f0f9";
const assetId = "64f0f0f0f0f0f0f0f0f0f0f2";
const requestId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0f3");

const userId = "64f0f0f0f0f0f0f0f0f0f0f4";

const principal = {
  email: "owner@example.com",
  hostelIds: [hostelId],
  role: Role.HOSTEL_ADMIN,
  userId,
} as never;

function lean<T>(value: T) {
  return { lean: () => Promise.resolve(value), select: () => ({ lean: () => Promise.resolve(value) }) };
}

function asset(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(assetId),
    hostelId: new Types.ObjectId(hostelId),
    kind: "MAINTENANCE_NOTE",
    mimeType: "audio/mp4",
    uploadCompletedAt: new Date("2026-09-02T00:00:00.000Z"),
    ...overrides,
  };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    category: "PLUMBING" as const,
    priority: "MEDIUM" as const,
    title: "Leaking tap in 204",
    voiceNoteAssetId: assetId,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requestCreate.mockResolvedValue({
    _id: requestId,
    category: "PLUMBING",
    hostelId: new Types.ObjectId(hostelId),
    priority: "MEDIUM",
    requestedBy: new Types.ObjectId(userId),
    status: "PENDING",
    title: "Leaking tap in 204",
    voiceNoteAssetId: new Types.ObjectId(assetId),
  });
  mocks.historyCreate.mockResolvedValue({
    _id: new Types.ObjectId(),
    action: "MAINTENANCE_REQUEST_CREATED",
    actorId: new Types.ObjectId(userId),
    hostelId: new Types.ObjectId(hostelId),
    requestId,
  });
});

describe("createMaintenanceRequest — the voice note", () => {
  it("attaches a completed audio note belonging to this hostel", async () => {
    mocks.assetFindOne.mockReturnValue(lean(asset()));

    const result = await createMaintenanceRequest(input(), principal);

    expect(mocks.requestCreate).toHaveBeenCalledWith(
      expect.objectContaining({ voiceNoteAssetId: new Types.ObjectId(assetId) }),
    );
    expect(result.request.voiceNoteAssetId).toBe(assetId);
  });

  it("refuses one that never finished uploading", async () => {
    // A presign with no PUT behind it leaves a row and no bytes. Attaching it
    // gives the provider a play button that does nothing.
    mocks.assetFindOne.mockReturnValue(lean(asset({ uploadCompletedAt: undefined })));

    await expect(createMaintenanceRequest(input(), principal)).rejects.toThrow(
      /did not finish uploading/i,
    );
    expect(mocks.requestCreate).not.toHaveBeenCalled();
  });

  it("refuses another hostel's recording", async () => {
    // The id is a string a client supplies. A guessed one must not become
    // readable by being attached to a request.
    mocks.assetFindOne.mockReturnValue(
      lean(asset({ hostelId: new Types.ObjectId(otherHostelId) })),
    );

    await expect(createMaintenanceRequest(input(), principal)).rejects.toThrow(
      /does not belong to this hostel/i,
    );
  });

  it("refuses an asset that is not a maintenance note", async () => {
    // `MAINTENANCE_NOTE` is the kind `files/{id}/url` widens to the assigned
    // provider, so this is the check that stops a payment proof reaching a
    // contractor.
    mocks.assetFindOne.mockReturnValue(
      lean(asset({ kind: "PAYMENT_PROOF", mimeType: "image/jpeg" })),
    );

    await expect(createMaintenanceRequest(input(), principal)).rejects.toThrow(
      /audio recording/i,
    );
  });

  it("refuses a note whose bytes are not audio", async () => {
    mocks.assetFindOne.mockReturnValue(lean(asset({ mimeType: "image/png" })));

    await expect(createMaintenanceRequest(input(), principal)).rejects.toThrow(
      /audio recording/i,
    );
  });

  it("raises a request with no recording at all without touching the assets", async () => {
    const result = await createMaintenanceRequest(
      input({ voiceNoteAssetId: undefined }),
      principal,
    );

    expect(mocks.assetFindOne).not.toHaveBeenCalled();
    expect(result.request.title).toBe("Leaking tap in 204");
  });
});
