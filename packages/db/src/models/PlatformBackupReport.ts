import { Schema, model, models } from "mongoose";

/**
 * What the server knows about the platform backup (docs/BACKUP.md, I1–I2).
 *
 * Posted to `/api/v1/cron/platform-backup` with the cron secret — by the
 * nightly workflow (`BACKUP`) and by the owner's restore drill (`DRILL`). The
 * server holds no key to the backups bucket; this row is all it sees.
 */
const platformBackupReportSchema = new Schema(
  {
    kind: { enum: ["BACKUP", "DRILL"], required: true, type: String },
    file: { required: true, trim: true, type: String },
    /** When the archive was made. */
    archivedAt: Date,
    bytes: Number,
    sha256: { trim: true, type: String },
    collections: Number,
    documents: Number,
    ok: { default: true, type: Boolean },
    /** Drill only: collections whose restored count differs from the manifest. */
    mismatches: [{ _id: false, actual: Number, collection: String, expected: Number }],
  },
  { timestamps: true },
);

platformBackupReportSchema.index({ kind: 1, createdAt: -1 });

export const PlatformBackupReportModel =
  models.PlatformBackupReport || model("PlatformBackupReport", platformBackupReportSchema);
