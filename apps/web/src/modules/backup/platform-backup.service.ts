import { z } from "zod";

import { connectToDatabase } from "@/lib/db";
import { PlatformBackupReportModel } from "@hostel/db/models/PlatformBackupReport";

/**
 * What the server knows about the platform backup (docs/BACKUP.md I1–I2).
 *
 * The server holds no key to the backups bucket. The nightly workflow and the
 * owner's restore drill each post their manifest here with the cron secret, and
 * this is all the superadmin status row reads.
 */

const manifestSchema = z.object({
  bytes: z.number().int().nonnegative().optional(),
  collections: z.record(z.string(), z.number().int().nonnegative()),
  createdAt: z.string().optional(),
  file: z.string().trim().min(1).max(200),
  sha256: z.string().trim().max(128).optional(),
});

export const platformBackupReportSchema = z.object({
  kind: z.enum(["BACKUP", "DRILL"]),
  manifest: manifestSchema,
  mismatches: z
    .array(z.object({ actual: z.number().int(), collection: z.string().max(120), expected: z.number().int() }))
    .max(500)
    .default([]),
  ok: z.boolean().default(true),
});

export async function recordPlatformBackupReport(input: z.infer<typeof platformBackupReportSchema>) {
  await connectToDatabase();

  const counts = Object.values(input.manifest.collections);
  const archivedAt = input.manifest.createdAt ? new Date(input.manifest.createdAt) : undefined;

  await PlatformBackupReportModel.create({
    archivedAt: archivedAt && !Number.isNaN(archivedAt.getTime()) ? archivedAt : undefined,
    bytes: input.manifest.bytes,
    collections: counts.length,
    documents: counts.reduce((total, count) => total + count, 0),
    file: input.manifest.file,
    kind: input.kind,
    // A backup is only "ok" by being posted; a drill says so itself, and a count off is a failure.
    mismatches: input.mismatches,
    ok: input.kind === "BACKUP" ? true : input.ok && input.mismatches.length === 0,
    sha256: input.manifest.sha256,
  });
}

type ReportRow = {
  archivedAt?: Date;
  bytes?: number;
  collections?: number;
  createdAt: Date;
  documents?: number;
  file: string;
  mismatches?: Array<{ actual: number; collection: string; expected: number }>;
  ok?: boolean;
};

const STALE_HOURS = 30;

/** Superadmin status row: the latest backup, the latest drill, and whether a drill has ever passed. */
export async function getPlatformBackupStatus(now = new Date()) {
  await connectToDatabase();

  const [backup, drill, passed] = await Promise.all([
    PlatformBackupReportModel.findOne({ kind: "BACKUP" }).sort({ createdAt: -1 }).lean<ReportRow | null>(),
    PlatformBackupReportModel.findOne({ kind: "DRILL" }).sort({ createdAt: -1 }).lean<ReportRow | null>(),
    PlatformBackupReportModel.findOne({ kind: "DRILL", ok: true }).sort({ createdAt: -1 }).lean<ReportRow | null>(),
  ]);
  const backupAt = backup?.archivedAt ?? backup?.createdAt ?? null;

  return {
    backup: backup
      ? {
          at: backupAt!.toISOString(),
          bytes: backup.bytes ?? null,
          collections: backup.collections ?? 0,
          documents: backup.documents ?? 0,
          file: backup.file,
          stale: now.getTime() - backupAt!.getTime() > STALE_HOURS * 3_600_000,
        }
      : null,
    drill: drill
      ? { at: drill.createdAt.toISOString(), file: drill.file, mismatches: drill.mismatches ?? [], ok: Boolean(drill.ok) }
      : null,
    lastPassedDrill: passed ? { at: passed.createdAt.toISOString(), file: passed.file } : null,
  };
}
