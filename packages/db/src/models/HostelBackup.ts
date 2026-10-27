import { Schema, model, models } from "mongoose";

/**
 * A hostel's customer backup settings (docs/FIELD_REVIEW_2026_10_27.md I4–I6).
 *
 * Holds the owner's **public** key only — the private half never leaves their
 * phone and recovery kit — and the Google Drive refresh token, sealed with the
 * finance master key (`sealValue`, scope `{hostelId, DRIVE_REFRESH_TOKEN}`) so
 * a database read alone does not hand over anyone's Drive.
 */
const hostelBackupSchema = new Schema(
  {
    hostelId: { ref: "Hostel", required: true, type: Schema.Types.ObjectId },
    /** X25519 public key, base64. */
    publicKey: { trim: true, type: String },
    keyFingerprint: { trim: true, type: String },
    keySetAt: Date,
    keySetBy: { ref: "User", type: Schema.Types.ObjectId },
    /** The owner said the recovery kit is saved. Set on the phone that made the key. */
    kitConfirmedAt: Date,
    drive: {
      connectedAt: Date,
      email: { trim: true, type: String },
      /** Last Drive failure, in words, for the screen. */
      error: { trim: true, type: String },
      status: {
        default: "NOT_CONNECTED",
        enum: ["NOT_CONNECTED", "CONNECTED", "REVOKED", "QUOTA_FULL", "ERROR"],
        type: String,
      },
      /** `SecretEnvelope` of the refresh token. */
      token: { select: false, type: Schema.Types.Mixed },
    },
    lastRunAt: Date,
  },
  { timestamps: true },
);

hostelBackupSchema.index({ hostelId: 1 }, { unique: true });
hostelBackupSchema.index({ "drive.status": 1, lastRunAt: 1 });

export const HostelBackupModel = models.HostelBackup || model("HostelBackup", hostelBackupSchema);
