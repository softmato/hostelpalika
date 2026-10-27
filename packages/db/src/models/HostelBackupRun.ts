import { Schema, model, models } from "mongoose";

/**
 * One customer backup attempt — the history on the Backup screen.
 *
 * `sha512` is of the encrypted file as uploaded (SHA-512 because the phone's
 * NaCl has it). `chunks` hashes each piece of what was inside it: restore takes
 * rows back only as chunks whose hash is recorded here for the same hostel, so
 * an archive cannot be forged by anyone holding the (public) key, nor carried
 * to another hostel.
 */
const hostelBackupRunSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    status: { enum: ["OK", "FAILED"], required: true, type: String },
    trigger: { default: "SCHEDULE", enum: ["SCHEDULE", "MANUAL"], type: String },
    fileName: { trim: true, type: String },
    bytes: Number,
    sha512: { trim: true, type: String },
    chunks: [{ _id: false, collection: String, index: Number, rows: Number, sha256: String }],
    keyFingerprint: { trim: true, type: String },
    driveFileId: { trim: true, type: String },
    /** Drive's own md5 of the stored file matched ours. */
    checked: { default: false, type: Boolean },
    counts: { type: Schema.Types.Mixed },
    error: { trim: true, type: String },
  },
  { timestamps: true },
);

hostelBackupRunSchema.index({ hostelId: 1, createdAt: -1 });

export const HostelBackupRunModel = models.HostelBackupRun || model("HostelBackupRun", hostelBackupRunSchema);
