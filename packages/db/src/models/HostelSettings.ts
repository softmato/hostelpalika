import { Schema, model, models } from "mongoose";

/**
 * Per-hostel operational settings (ARCHITECTURE.md §5, second level of the
 * PlatformConfig → HostelSettings hierarchy). One document per hostel.
 */
const hostelSettingsSchema = new Schema(
  {
    hostelId: {
      ref: "Hostel",
      required: true,
      type: Schema.Types.ObjectId,
      unique: true,
    },
    cookPortalEnabled: { default: false, type: Boolean },
    /**
     * Whether the cook account may add what it spends (docs/EXPENSES_PLAN.md §1).
     * Off until the owner turns it on: the cook login can be a shared phone, and
     * money is not part of the cook portal by default.
     */
    cookCanRecordExpenses: { default: false, type: Boolean },
    cookName: { trim: true, type: String },
    cookUserId: { ref: "User", type: Schema.Types.ObjectId },
    /**
     * When the current shared cook password was issued. Only the bcrypt hash is
     * ever stored, so this timestamp (plus the account's `mustChangePassword`
     * flag) is what the dashboard shows in place of the password itself.
     */
    cookCredentialIssuedAt: Date,
    /**
     * Geofence + attendance configuration (PHASES.md §4.1). Radii are metres
     * from the hostel's own coordinates. The platform sets the ceilings; a
     * hostel admin tunes within them.
     */
    attendance: {
      type: {
        /** Absence streak (days) that raises an AttendanceAlert. */
        absenceAlertDays: { default: 14, max: 90, min: 1, type: Number },
        enabled: { default: false, type: Boolean },
        /** Last time `enabled` went false → true; the absence alert counts from here. */
        enabledAt: Date,
        insideZoneRadiusMeters: { default: 50, max: 500, min: 10, type: Number },
        nearbyZoneRadiusMeters: { default: 200, max: 2000, min: 20, type: Number },
        /** How long raw AttendanceLog rows are kept before the purge job. */
        retentionDays: { default: 600, max: 1095, min: 30, type: Number },
        /** Local times (HH:mm) the mobile app is expected to ping at. */
        pingTimes: { default: ["06:00", "08:00", "22:00"], type: [String] },
        /**
         * The nightly "are you in tonight?" prompt.
         *
         * ## Why it lives under `attendance` and not beside it
         *
         * Because this is the settings block a warden opens when they want to
         * change anything about how the hostel tracks who is in. Splitting the
         * prompt into a sibling block would mean two screens, two endpoints and
         * two chances for a hostel to have the geofence on and the prompt off
         * without anybody noticing the difference — and the two answer the same
         * question by different means.
         *
         * It is deliberately **one field on one document**: the app's editor and
         * the web's editor both `PATCH` the existing attendance-settings route,
         * so a warden who changes the hour on their phone has changed it on the
         * website by the time they look. That is the whole "single source"
         * requirement, and it is satisfied by not adding a second store rather
         * than by syncing two.
         */
        nightStatus: {
          type: {
            /**
             * **On by default**, and a hostel has to opt *out*.
             *
             * The opposite of how the geofence next door works, deliberately.
             * The geofence reads a resident's location whether or not they are
             * thinking about it, so it defaults off and has to be chosen. This
             * asks a question the resident answers or ignores — nothing is read,
             * nothing is inferred from silence — and a hostel that has to
             * discover a setting before anybody is ever asked is a hostel where
             * the warden keeps knocking on doors.
             *
             * `false` is stored only when somebody explicitly turns it off,
             * which is why the sender tests `$ne: false` rather than `=== true`:
             * a settings document written before this field existed has no value
             * at all, and that absence has to mean the default rather than "off".
             */
            promptEnabled: { default: true, type: Boolean },
            /**
             * `HH:mm` in Nepal. 20:00 unless the warden says otherwise.
             *
             * Bounded 17:00–23:45 by `parsePromptTime` rather than by the
             * schema, because the reason for the bound is the night boundary
             * and that reasoning belongs beside the boundary. An out-of-range
             * value here means the hostel is skipped, never that it is prompted
             * at an hour nobody chose.
             */
            promptTime: { default: "20:00", type: String },
            /**
             * How often whoever has not answered is asked again: 15, 30 or 60
             * minutes, until five hours after `promptTime` or 01:00. Anything
             * else — including the `remindAfterMinutes` this replaced, still on
             * older documents — reads as the default 30. See `promptRound`.
             */
            repeatEveryMinutes: { default: 30, enum: [15, 30, 60], type: Number },
          },
          default: () => ({}),
        },
      },
      default: () => ({}),
    },
    /**
     * Community feed controls (PHASES.md §5.1). Both default to the platform's
     * position: the feed is on, and the profanity mask is on — a hostel may turn
     * either off for its own residents.
     */
    community: {
      type: {
        enabled: { default: true, type: Boolean },
        profanityFilterEnabled: { default: true, type: Boolean },
      },
      default: () => ({}),
    },
    /**
     * Fine for paying rent late — see `late-fine.service`. When on, a month's
     * bill is due on day `graceDays` and every day after that adds the fine to
     * the unpaid bill as one `Late fine` line.
     */
    lateFine: {
      type: {
        enabled: { default: false, type: Boolean },
        /** Rupees a day, or a percent of the bill a day. */
        mode: {
          default: "PER_DAY_AMOUNT",
          enum: ["PER_DAY_AMOUNT", "PER_DAY_PERCENT"],
          type: String,
        },
        rate: { default: 0, min: 0, type: Number },
        /** Days from the 1st the bill can be paid without a fine. */
        graceDays: { default: 5, max: 28, min: 1, type: Number },
        /** Last off → on. No bill is fined for days before this. */
        enabledAt: Date,
      },
      default: () => ({}),
    },
    /** What a resident can take on khata, and its price. See `khata.service`. */
    khataItems: {
      type: [
        {
          name: { maxlength: 40, required: true, trim: true, type: String },
          price: { min: 1, required: true, type: Number },
          active: { default: true, type: Boolean },
        },
      ],
      default: [],
    },
    createdBy: { ref: "User", type: Schema.Types.ObjectId },
    updatedBy: { ref: "User", type: Schema.Types.ObjectId },
  },
  { timestamps: true },
);

export const HostelSettingsModel =
  models.HostelSettings || model("HostelSettings", hostelSettingsSchema);
