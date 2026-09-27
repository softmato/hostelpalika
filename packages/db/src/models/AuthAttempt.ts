import { Schema, model, models } from "mongoose";

/**
 * Failed credential attempts in one fixed window (`lib/auth-attempts.ts`).
 *
 * In Mongo rather than process memory because Vercel runs many instances and
 * each held its own count — a guesser spread across them was barely slowed.
 * `key` names the door, the client and the window, so a single atomic `$inc`
 * with an upsert is the whole write; `expiresAt` lets the TTL index clear
 * finished windows. Both indexes are built by `db:indexes`.
 */
const authAttemptSchema = new Schema(
  {
    count: { default: 0, min: 0, type: Number },
    expiresAt: { required: true, type: Date },
    key: { required: true, trim: true, type: String },
  },
  { versionKey: false },
);

authAttemptSchema.index({ key: 1 }, { unique: true });
authAttemptSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthAttemptModel =
  models.AuthAttempt || model("AuthAttempt", authAttemptSchema);
