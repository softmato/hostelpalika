import { mongo, Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const A = new Types.ObjectId();
const B = new Types.ObjectId();
const OWNER = new Types.ObjectId().toString();

const mocks = vi.hoisted(() => ({
  existing: [] as Array<{ _id: unknown }>,
  inserted: [] as unknown[],
  runFindOne: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@/modules/billing/subscription-access", () => ({ resolveOwnedHostel: vi.fn() }));
vi.mock("@/modules/hostels/hostel.service", () => ({
  resolveAdminHostelId: (_principal: unknown, requested?: string) => new Types.ObjectId(requested),
}));
vi.mock("@hostel/db/models/AuditLog", () => ({ AuditLogModel: { create: vi.fn(async () => ({})) } }));
vi.mock("@hostel/db/models/HostelBackupRun", () => ({
  HostelBackupRunModel: {
    findOne: (filter: unknown) => ({ select: () => ({ lean: () => mocks.runFindOne(filter) }) }),
  },
}));
vi.mock("./tenant-export", async (original) => {
  const actual = await original<typeof import("./tenant-export")>();
  const collection = {
    find: () => ({ toArray: async () => mocks.existing }),
    insertMany: async (rows: unknown[]) => {
      mocks.inserted.push(...rows);
      return { insertedCount: rows.length };
    },
  };

  return {
    ...actual,
    TENANT_COLLECTIONS: [
      { key: "hostelId", model: { collection }, name: "Resident", restore: true },
      { key: "_id", model: { collection }, name: "Hostel", restore: false },
    ],
    tenantHostelIds: async (id: Types.ObjectId) => [id],
  };
});

process.env.JWT_ACCESS_SECRET = "test-secret";

const { readDriveState, restoreBackupChunk, signDriveState } = await import("./backup.service");
const { sha256Hex } = await import("./tenant-export");

const principal = { hostelIds: [A.toString()], role: "HOSTEL_ADMIN", userId: OWNER } as never;
const chunkOf = (rows: object[]) => mongo.BSON.EJSON.stringify(rows, { relaxed: false });

describe("restoreBackupChunk", () => {
  const rowA = { _id: new Types.ObjectId(), firstName: "Asha", hostelId: A };
  const data = chunkOf([rowA]);
  const run = (chunk = data) => ({
    _id: new Types.ObjectId(),
    chunks: [{ collection: "Resident", index: 0, rows: 1, sha256: sha256Hex(Buffer.from(chunk, "utf8")) }],
  });

  beforeEach(() => {
    mocks.existing = [];
    mocks.inserted = [];
    mocks.runFindOne.mockReset();
  });

  it("adds a missing row back when the chunk is the one recorded", async () => {
    const recorded = run();

    mocks.runFindOne.mockResolvedValue(recorded);

    const result = await restoreBackupChunk(principal, A.toString(), {
      collection: "Resident",
      data,
      index: 0,
      runId: recorded._id.toString(),
    });

    expect(result).toMatchObject({ added: 1, kept: 0 });
    expect(mocks.inserted).toHaveLength(1);
  });

  it("asks for the run inside this hostel only, so another hostel's archive is not found", async () => {
    mocks.runFindOne.mockResolvedValue(null);

    await expect(
      restoreBackupChunk(principal, A.toString(), { collection: "Resident", data, index: 0, runId: new Types.ObjectId().toString() }),
    ).rejects.toMatchObject({ errorCode: "BACKUP_NOT_FOUND" });
    expect(mocks.runFindOne.mock.calls[0]?.[0]).toMatchObject({ hostelId: A });
  });

  it("refuses an edited chunk", async () => {
    const recorded = run();

    mocks.runFindOne.mockResolvedValue(recorded);

    await expect(
      restoreBackupChunk(principal, A.toString(), {
        collection: "Resident",
        data: data.replace("Asha", "Asho"),
        index: 0,
        runId: recorded._id.toString(),
      }),
    ).rejects.toMatchObject({ errorCode: "BACKUP_CHUNK_MISMATCH" });
    expect(mocks.inserted).toHaveLength(0);
  });

  it("refuses rows of another hostel even under a matching hash", async () => {
    const foreign = chunkOf([{ _id: new Types.ObjectId(), hostelId: B }]);
    const recorded = run(foreign);

    mocks.runFindOne.mockResolvedValue(recorded);

    await expect(
      restoreBackupChunk(principal, A.toString(), { collection: "Resident", data: foreign, index: 0, runId: recorded._id.toString() }),
    ).rejects.toMatchObject({ errorCode: "BACKUP_OTHER_HOSTEL" });
    expect(mocks.inserted).toHaveLength(0);
  });

  it("leaves existing rows alone and never restores platform records", async () => {
    const recorded = run();

    mocks.runFindOne.mockResolvedValue(recorded);
    mocks.existing = [{ _id: rowA._id }];

    expect(
      await restoreBackupChunk(principal, A.toString(), { collection: "Resident", data, index: 0, runId: recorded._id.toString() }),
    ).toMatchObject({ added: 0, kept: 1 });

    const hostel = chunkOf([{ _id: A }]);
    const hostelRun = { _id: new Types.ObjectId(), chunks: [{ collection: "Hostel", index: 0, rows: 1, sha256: sha256Hex(Buffer.from(hostel)) }] };

    mocks.runFindOne.mockResolvedValue(hostelRun);
    expect(
      await restoreBackupChunk(principal, A.toString(), { collection: "Hostel", data: hostel, index: 0, runId: hostelRun._id.toString() }),
    ).toMatchObject({ added: 0, restorable: false });
    expect(mocks.inserted).toHaveLength(0);
  });
});

describe("Drive OAuth state", () => {
  const state = { e: Date.now() + 60_000, f: "app" as const, h: A.toString(), u: OWNER };

  it("reads back what it signed", () => {
    expect(readDriveState(signDriveState(state))).toEqual(state);
  });

  it("refuses an edited or expired state", () => {
    const [body, mac] = signDriveState(state).split(".");
    const forged = Buffer.from(JSON.stringify({ ...state, h: B.toString() })).toString("base64url");

    expect(readDriveState(`${forged}.${mac}`)).toBeNull();
    expect(readDriveState(`${body}.${mac}`, state.e + 1)).toBeNull();
  });
});
