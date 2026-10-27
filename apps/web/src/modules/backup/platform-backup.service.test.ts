import { describe, expect, it, vi } from "vitest";

const created = vi.hoisted(() => [] as Array<Record<string, unknown>>);

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));
vi.mock("@hostel/db/models/PlatformBackupReport", () => ({
  PlatformBackupReportModel: { create: async (row: Record<string, unknown>) => created.push(row) },
}));

const { platformBackupReportSchema, recordPlatformBackupReport } = await import("./platform-backup.service");

// The shape `db-backup.yml` writes.
const manifest = {
  bytes: 1234,
  collections: { invoices: 40, residents: 12 },
  createdAt: "2026-10-27T20:16:03Z",
  file: "hostelpalika-2026-10-27T2015Z.archive.gz.age",
  sha256: "ab".repeat(32),
};

describe("platform backup reports", () => {
  it("reads the workflow's manifest and totals it", async () => {
    await recordPlatformBackupReport(platformBackupReportSchema.parse({ kind: "BACKUP", manifest }));

    expect(created.at(-1)).toMatchObject({ collections: 2, documents: 52, kind: "BACKUP", ok: true });
  });

  it("never records a drill as passed while a count is off", async () => {
    await recordPlatformBackupReport(
      platformBackupReportSchema.parse({
        kind: "DRILL",
        manifest,
        mismatches: [{ actual: 11, collection: "residents", expected: 12 }],
        ok: true,
      }),
    );

    expect(created.at(-1)).toMatchObject({ kind: "DRILL", ok: false });
  });
});
