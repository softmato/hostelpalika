import { Schema, model, models } from "mongoose";

/**
 * The daily roll-up of `UsageEvent` (H3): one row per person, Nepal day and
 * screen-or-feature, incremented as events arrive. Role and hostel ride on the
 * row, so "by role", "by hostel" and "top screens" are groupings of these rows
 * rather than separate tallies that could drift apart. Kept after the raw
 * events expire.
 *
 * `screen: ""` + `feature: ""` is the person's row for the day itself (opens).
 */
const usageDailySchema = new Schema(
  {
    /** Nepal calendar day, `YYYY-MM-DD` (Gregorian, UTC+5:45). */
    day: { required: true, type: String },
    userId: { ref: "User", required: true, type: Schema.Types.ObjectId },
    role: { required: true, type: String },
    hostelId: { default: null, ref: "Hostel", type: Schema.Types.ObjectId },
    screen: { default: "", type: String },
    feature: { default: "", type: String },
    opens: { default: 0, type: Number },
    views: { default: 0, type: Number },
    durationMs: { default: 0, type: Number },
    uses: { default: 0, type: Number },
  },
  { timestamps: false },
);

usageDailySchema.index({ day: 1, userId: 1, hostelId: 1, screen: 1, feature: 1 }, { unique: true });
usageDailySchema.index({ userId: 1, day: -1 });

export const UsageDailyModel = models.UsageDaily || model("UsageDaily", usageDailySchema);
