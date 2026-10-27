import { Schema, model, models } from "mongoose";

/**
 * Our own usage watcher (FIELD_REVIEW_2026_10_27 H3): one row per thing a
 * signed-in person did in the app or a web portal — opened it, spent time on a
 * screen, used a feature. Raw rows live for `USAGE_EVENT_TTL_DAYS` and exist
 * for drilling into one person; every chart reads `UsageDaily`, which is
 * written in the same request and kept.
 *
 * `screen` is a route template (`/manage/scan/[residentId]`) or a path with its
 * ids replaced by `:id`, and `feature` is the API write it made (`POST
 * /hostel-admin/expenses`) — never a body, never a query string.
 */
export const USAGE_EVENT_TTL_DAYS = 90;

export const USAGE_EVENT_KINDS = ["open", "screen", "feature"] as const;
export const USAGE_CLIENTS = ["app", "web"] as const;

const usageEventSchema = new Schema(
  {
    userId: { ref: "User", required: true, type: Schema.Types.ObjectId },
    role: { required: true, type: String },
    /** The hostel the request was scoped to; null for platform and public roles. */
    hostelId: { default: null, ref: "Hostel", type: Schema.Types.ObjectId },
    client: { enum: USAGE_CLIENTS, required: true, type: String },
    kind: { enum: USAGE_EVENT_KINDS, required: true, type: String },
    screen: { default: "", type: String },
    feature: { default: "", type: String },
    /** Time on the screen, for `kind: "screen"`. */
    durationMs: { default: 0, type: Number },
    /** When it happened on the device, clamped to the last week by ingest. */
    at: { required: true, type: Date },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

usageEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: USAGE_EVENT_TTL_DAYS * 24 * 60 * 60 });
usageEventSchema.index({ userId: 1, at: -1 });

export const UsageEventModel = models.UsageEvent || model("UsageEvent", usageEventSchema);
