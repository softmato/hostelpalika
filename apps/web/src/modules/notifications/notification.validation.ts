import { z } from "zod";

import { paginationQuerySchema } from "@/lib/pagination";
import { EMAIL_TOPIC_VALUES } from "@/lib/notifications/email-topics";

const objectIdSchema = z.string().regex(/^[a-f\d]{24}$/i, "Invalid object id.");

export const notificationPrioritySchema = z.enum(["LOW", "NORMAL", "HIGH", "URGENT"]);

const campaignBaseSchema = {
  body: z.string().trim().min(2).max(2000),
  category: z.string().trim().min(2).max(60).default("ANNOUNCEMENT"),
  priority: notificationPrioritySchema.default("NORMAL"),
  /**
   * Absent means "send now". A past timestamp is rejected rather than silently
   * dispatched — an admin who typed yesterday's date meant something else.
   */
  scheduledFor: z.coerce.date().optional(),
  title: z.string().trim().min(2).max(160),
};

export const hostelNotificationCampaignSchema = z
  .object({
    ...campaignBaseSchema,
    audience: z.enum(["ALL", "RESIDENTS", "GUARDIANS", "SPECIFIC"]).default("ALL"),
    hostelId: objectIdSchema.optional(),
    residentIds: z.array(objectIdSchema).max(500).default([]),
  })
  .refine((value) => value.audience !== "SPECIFIC" || value.residentIds.length > 0, {
    message: "Select at least one resident.",
    path: ["residentIds"],
  });

export const platformNotificationCampaignSchema = z.object({
  ...campaignBaseSchema,
  /** Empty means every hostel on the platform. */
  hostelIds: z.array(objectIdSchema).max(200).default([]),
});

/**
 * A superadmin push straight to devices. Who it reaches is picked by role, not
 * by hostel — see `platform-push.service.ts`.
 */
export const PLATFORM_PUSH_AUDIENCES = [
  "EVERYONE",
  "HOSTEL_STAFF",
  "RESIDENTS",
  "GUARDIANS",
] as const;

const nepalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Pick a date.");

export const platformPushSchema = z
  .object({
    audience: z.enum(PLATFORM_PUSH_AUDIENCES).default("EVERYONE"),
    body: z.string().trim().min(2).max(500),
    /** Nepal date of a ONCE, or the first date of a repeat. Defaults to today. */
    date: nepalDateSchema.optional(),
    endsOn: nepalDateSchema.optional(),
    /** `NOW` sends in this request; the rest are left to the cron. */
    repeat: z.enum(["NOW", "ONCE", "DAILY", "WEEKLY"]).default("NOW"),
    time: z
      .string()
      .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Pick a time.")
      .optional(),
    title: z.string().trim().min(2).max(120),
    urgency: z.enum(["NORMAL", "URGENT"]).default("NORMAL"),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  })
  .superRefine((value, context) => {
    if (value.repeat === "NOW") {
      return;
    }

    if (!value.time) {
      context.addIssue({ code: "custom", message: "Pick a time.", path: ["time"] });
    }

    if (value.repeat === "ONCE" && !value.date) {
      context.addIssue({ code: "custom", message: "Pick a date.", path: ["date"] });
    }

    if (value.repeat === "WEEKLY" && value.weekdays.length === 0) {
      context.addIssue({ code: "custom", message: "Pick at least one day.", path: ["weekdays"] });
    }
  });

export const platformPushScheduleActionSchema = z.object({
  action: z.enum(["PAUSE", "RESUME", "CANCEL"]),
});

export const notificationCampaignListQuerySchema = z.object({
  ...paginationQuerySchema,
  hostelId: objectIdSchema.optional(),
});

export const deviceTokenSaveSchema = z.object({
  /** See `DeviceToken.capabilities`. Absent from every build that predates it. */
  capabilities: z.array(z.string().trim().min(1).max(64)).max(20).optional(),
  deviceId: z.string().trim().max(160).optional(),
  platform: z.enum(["IOS", "ANDROID", "WEB"]),
  token: z.string().trim().min(8).max(4096),
});

/**
 * Sign-out. Only the token, because the caller is already authenticated and the
 * service refuses to revoke a row belonging to anyone else — see
 * `revokeDeviceToken`.
 */
export const deviceTokenRevokeSchema = z.object({
  token: z.string().trim().min(8).max(4096),
});

/**
 * A browser handing over its push subscription.
 *
 * The shape is `PushSubscription.toJSON()` verbatim, so the client posts what
 * the browser gave it without reshaping — a client that has to rearrange the
 * subscription is a client that can rearrange it wrongly, and the failure shows
 * up as "push works in Chrome, not in Firefox".
 *
 * `endpoint` must be an https URL: it is the address `webpush.sendNotification`
 * dials, and it arrives from a page. The keys are base64url and fixed-length in
 * practice (65 bytes for `p256dh`, 16 for `auth`), but their exact encoding is
 * the browser's business — length bounds only, so a future curve does not need
 * a deploy here.
 */
export const webPushSubscribeSchema = z.object({
  subscription: z.object({
    endpoint: z
      .string()
      .trim()
      .min(12)
      .max(2048)
      .refine((value) => value.startsWith("https://"), {
        message: "A push endpoint has to be an https URL.",
      }),
    expirationTime: z.number().int().nullable().optional(),
    keys: z.object({
      auth: z.string().trim().min(8).max(256),
      p256dh: z.string().trim().min(8).max(256),
    }),
  }),
  /** Sent by the installable app at `/app`, whose clicks open app screens — see `PWA_PUSH`. */
  app: z.boolean().optional(),
});

export const webPushUnsubscribeSchema = z.object({
  endpoint: z.string().trim().min(12).max(2048),
});

/**
 * Notification preferences.
 *
 * Every field optional so the client can PATCH one switch without echoing the
 * whole object back — a settings screen that has to round-trip the full record
 * to flip one toggle will eventually overwrite a field it never showed.
 *
 * Times are minutes past local midnight (0–1439); see the model for why they are
 * not `Date`s. `mutedCategories` is capped so the array cannot be used as
 * unbounded storage.
 */
export const notificationPreferenceUpdateSchema = z.object({
  mutedCategories: z.array(z.string().trim().min(1).max(40)).max(40).optional(),
  pushEnabled: z.boolean().optional(),
  quietHoursEnabled: z.boolean().optional(),
  quietHoursEnd: z.number().int().min(0).max(1439).optional(),
  quietHoursStart: z.number().int().min(0).max(1439).optional(),
  timeZone: z.string().trim().min(1).max(64).optional(),
});

export const emailPreferenceUpdateSchema = z.object({
  mutedTopics: z.array(z.enum(EMAIL_TOPIC_VALUES)).max(EMAIL_TOPIC_VALUES.length),
});
