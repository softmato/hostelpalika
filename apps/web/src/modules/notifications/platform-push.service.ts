import { Types } from "mongoose";
import type { z } from "zod";

import { NotificationCampaignError as ApiError } from "@/modules/notifications/notification-campaign.service";
import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { Role } from "@/lib/roles";
import { sendFreeMonthWelcomes } from "@/modules/billing/free-month-welcome.service";
import { sendPlanDueReminders } from "@/modules/billing/plan-due-reminders.service";
import { sendFeeDueReminders } from "@/modules/finance/fee-due-reminders.service";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { NotificationModel } from "@hostel/db/models/Notification";
import { PlatformPushScheduleModel } from "@hostel/db/models/PlatformPushSchedule";
import { UserModel } from "@hostel/db/models/User";
import type {
  PLATFORM_PUSH_AUDIENCES,
  platformPushSchema,
} from "@/modules/notifications/notification.validation";
import {
  nepalDateOf,
  nextOccurrence,
  type PushRepeat,
} from "@/modules/notifications/platform-push-schedule";
import { sendPushToUsers } from "@/modules/notifications/push.service";

type PlatformPushInput = z.infer<typeof platformPushSchema>;
type PlatformPushAudience = (typeof PLATFORM_PUSH_AUDIENCES)[number];
type Urgency = "NORMAL" | "URGENT";

type PushMessage = {
  audience: PlatformPushAudience;
  body: string;
  title: string;
  urgency: Urgency;
};

const ACTION = "PLATFORM_PUSH_SENT";
const ENTITY_TYPE = "PlatformPush";

/**
 * Not `ANNOUNCEMENT`: that category deep-links into the resident notices tab,
 * which a hostel admin or guardian cannot open. An unknown category lands on
 * each app's own notifications screen, where the bell row below is waiting.
 */
const CATEGORY = "PLATFORM";

/**
 * How late a **repeat** may still go out. A "good morning" whose 09:00 run was
 * missed because the cron was down should not arrive at 20:00 — that occurrence
 * is skipped and the next one stands. A ONCE always goes, however late: the
 * superadmin asked for exactly one send and would otherwise get none.
 */
const REPEAT_GRACE_MS = 30 * 60_000;

/** `null` is every active account, platform staff included — so the sender's own phone proves it went. */
const AUDIENCE_ROLES: Record<PlatformPushAudience, Role[] | null> = {
  EVERYONE: null,
  GUARDIANS: [Role.GUARDIAN],
  HOSTEL_STAFF: [Role.HOSTEL_ADMIN, Role.WARDEN, Role.COOK],
  RESIDENTS: [Role.RESIDENT],
};

type PushLogRecord = {
  _id: Types.ObjectId;
  createdAt: Date;
  metadata?: Partial<PushMessage> & {
    devices?: number;
    recipients?: number;
    scheduleId?: string;
  };
};

/**
 * The platform's own reminders, filed as schedule rows so the superadmin sees
 * them on the Push tab beside their own, and can pause them.
 *
 * Each row's audience and text are worked out per recipient when it runs — who
 * owes, how much, how many days — so `title` and `body` here are what the list
 * shows, not what a phone shows. A week and five days before a due day the
 * morning row reminds once (`earlyDays`); from three days before, both rows
 * remind every day until the bill is paid (`remindsToday`). The plan's morning
 * row emails the owner too, so an inbox gets one a day while the push goes twice.
 */
export const AUTOMATIC_PUSHES = {
  PLAN_DUE_MORNING: {
    audience: "HOSTEL_STAFF",
    body: "Hostel admins whose plan payment is due or late, and an email to the owner with the website link to pay. 7 and 5 days before the due day, then every day from 3 days before until paid.",
    earlyDays: [7, 5],
    email: true,
    kind: "PLAN_DUE",
    time: "08:00",
    title: "Plan payment reminder · morning",
  },
  PLAN_DUE_EVENING: {
    audience: "HOSTEL_STAFF",
    body: "Hostel admins whose plan payment is due or late. Every day from 3 days before the due day until paid.",
    earlyDays: [],
    email: false,
    kind: "PLAN_DUE",
    time: "21:00",
    title: "Plan payment reminder · evening",
  },
  FEE_DUE_MORNING: {
    audience: "RESIDENTS",
    body: "Residents with an unpaid hostel fee: \"Please pay your hostel fee for <month>.\" 7 and 5 days before the due day, then every day from 3 days before until paid.",
    earlyDays: [7, 5],
    email: false,
    kind: "FEE_DUE",
    time: "08:00",
    title: "Hostel fee reminder · morning",
  },
  FEE_DUE_EVENING: {
    audience: "RESIDENTS",
    body: "Residents with an unpaid hostel fee. Every day from 3 days before the due day until paid.",
    earlyDays: [],
    email: false,
    kind: "FEE_DUE",
    time: "21:00",
    title: "Hostel fee reminder · evening",
  },
  FREE_MONTH_MORNING: {
    audience: "HOSTEL_STAFF",
    body: "Hostel admins on their plan's free months, once in each free month: \"Welcome — enjoy the free <plan> plan this month\", with how many free months are left.",
    earlyDays: [],
    email: false,
    kind: "FREE_MONTH",
    time: "08:00",
    title: "Free month welcome",
  },
} as const satisfies Record<
  string,
  Omit<PushMessage, "urgency"> & {
    earlyDays: readonly number[];
    email: boolean;
    kind: "FEE_DUE" | "FREE_MONTH" | "PLAN_DUE";
    time: string;
  }
>;

export type AutomaticPushKey = keyof typeof AUTOMATIC_PUSHES;

type ScheduleRecord = PushMessage & {
  _id: Types.ObjectId;
  automatic?: AutomaticPushKey;
  createdBy?: Types.ObjectId;
  endsOn?: string | null;
  lastDevices?: number;
  lastRecipients?: number;
  lastRunAt?: Date | null;
  nextRunAt: Date | null;
  repeat: PushRepeat;
  runCount?: number;
  startsOn: string;
  status: "ACTIVE" | "PAUSED" | "COMPLETED" | "CANCELLED";
  time: string;
  weekdays?: number[];
};

/**
 * One push to every device of the audience — phones through Expo, browsers
 * through Web Push, in the single `sendPushToUsers` fan-out.
 *
 * A bell row is written per recipient first, so the tap has something to open
 * and a phone that was off still finds it later. No socket broadcast: the push
 * banner is the interruption, and a socket toast on top of it would chime twice.
 */
async function deliverPush(message: PushMessage, actorId: string, scheduleId?: string) {
  const roles = AUDIENCE_ROLES[message.audience];
  const filter: Record<string, unknown> = { isDeleted: { $ne: true }, status: "ACTIVE" };

  if (roles) {
    filter.role = { $in: roles };
  }

  const users = await UserModel.find(filter)
    .select("_id")
    .lean<Array<{ _id: Types.ObjectId }>>();
  const userIds = users.map((user) => user._id.toString());
  const now = new Date();

  if (userIds.length > 0) {
    await NotificationModel.insertMany(
      userIds.map((userId) => ({
        body: message.body,
        category: CATEGORY,
        channel: "IN_APP",
        deliveredAt: now,
        priority: message.urgency,
        status: "SENT",
        title: message.title,
        userId,
      })),
      { ordered: false },
    );
  }

  const result =
    userIds.length > 0
      ? await sendPushToUsers(userIds, {
          body: message.body,
          category: CATEGORY,
          priority: message.urgency,
          title: message.title,
        })
      : { revoked: 0, sent: 0, skipped: true };

  const metadata = {
    ...message,
    devices: result.sent,
    recipients: userIds.length,
    ...(scheduleId ? { scheduleId } : {}),
  };
  const log = await AuditLogModel.create({
    action: ACTION,
    actorId,
    entityId: scheduleId ?? new Types.ObjectId().toString(),
    entityType: ENTITY_TYPE,
    metadata,
  });

  return serializePush({ _id: log._id as Types.ObjectId, createdAt: now, metadata });
}

let seeded: Promise<void> | null = null;

/**
 * Files each automatic row the first time this instance needs it. An existing
 * row is left exactly as it is — paused stays paused. Two instances seeding at
 * once meet at the unique index, and the loser's duplicate-key error is the
 * row already being there.
 */
function ensureAutomaticPushes() {
  seeded ??= Promise.all(
    (Object.keys(AUTOMATIC_PUSHES) as AutomaticPushKey[]).map((key) => {
      const { audience, body, time, title } = AUTOMATIC_PUSHES[key];
      const now = new Date();
      const timing = { repeat: "DAILY" as const, startsOn: nepalDateOf(now), time };

      return PlatformPushScheduleModel.updateOne(
        { automatic: key },
        {
          $setOnInsert: {
            ...timing,
            audience,
            body,
            nextRunAt: nextOccurrence(timing, now),
            status: "ACTIVE",
            title,
            urgency: "NORMAL",
          },
        },
        { upsert: true },
      ).catch((error: { code?: number }) => {
        if (error?.code !== 11000) {
          throw error;
        }
      });
    }),
  ).then(
    () => undefined,
    (error: unknown) => {
      seeded = null;
      throw error;
    },
  );

  return seeded;
}

/** One run of an automatic row. What it returns is shown on the row. */
async function deliverAutomatic(key: AutomaticPushKey, now: Date) {
  const { earlyDays, email, kind } = AUTOMATIC_PUSHES[key];
  const result =
    kind === "PLAN_DUE"
      ? await sendPlanDueReminders({ earlyDays, email, now })
      : kind === "FREE_MONTH"
        ? await sendFreeMonthWelcomes({ now })
        : await sendFeeDueReminders({ earlyDays, now });

  return { devices: result.devices, recipients: result.recipients };
}

/** Sends now, or files a schedule for the cron. */
export async function sendPlatformPush(input: PlatformPushInput, principal: ApiPrincipal) {
  await connectToDatabase();

  const message: PushMessage = {
    audience: input.audience,
    body: input.body,
    title: input.title,
    urgency: input.urgency,
  };

  if (input.repeat === "NOW") {
    return { push: await deliverPush(message, principal.userId) };
  }

  const now = new Date();
  const timing = {
    endsOn: input.repeat === "ONCE" ? null : (input.endsOn ?? null),
    repeat: input.repeat,
    startsOn: input.date ?? nepalDateOf(now),
    time: input.time as string,
    weekdays: input.repeat === "WEEKLY" ? [...new Set(input.weekdays)].sort() : [],
  };
  // A minute of slack, so "today at the current minute" is not refused.
  const nextRunAt = nextOccurrence(timing, new Date(now.getTime() - 60_000));

  if (!nextRunAt) {
    throw new ApiError(
      input.repeat === "ONCE"
        ? "Pick a time in the future."
        : "That schedule never runs — check the end date and days.",
      "PUSH_SCHEDULE_NEVER_RUNS",
      422,
    );
  }

  const schedule = await PlatformPushScheduleModel.create({
    ...message,
    ...timing,
    createdBy: principal.userId,
    nextRunAt,
    status: "ACTIVE",
  });

  return { schedule: serializeSchedule(schedule.toObject() as ScheduleRecord) };
}

export async function listPlatformPushes() {
  await connectToDatabase();
  await ensureAutomaticPushes();

  const [logs, schedules, automatic] = await Promise.all([
    AuditLogModel.find({ action: ACTION }).sort({ createdAt: -1 }).limit(20).lean<PushLogRecord[]>(),
    PlatformPushScheduleModel.find({
      automatic: { $exists: false },
      status: { $in: ["ACTIVE", "PAUSED"] },
    })
      .sort({ nextRunAt: 1 })
      .limit(50)
      .lean<ScheduleRecord[]>(),
    PlatformPushScheduleModel.find({ automatic: { $exists: true } }).lean<ScheduleRecord[]>(),
  ]);
  const order = Object.keys(AUTOMATIC_PUSHES);

  return {
    automatic: automatic
      .sort((a, b) => order.indexOf(a.automatic ?? "") - order.indexOf(b.automatic ?? ""))
      .map(serializeSchedule),
    pushes: logs.map(serializePush),
    schedules: schedules.map(serializeSchedule),
  };
}

export async function updatePlatformPushSchedule(
  id: string,
  action: "PAUSE" | "RESUME" | "CANCEL",
) {
  await connectToDatabase();

  if (!Types.ObjectId.isValid(id)) {
    throw new ApiError("Schedule not found.", "PUSH_SCHEDULE_NOT_FOUND", 404);
  }

  const schedule = await PlatformPushScheduleModel.findById(id).lean<ScheduleRecord | null>();

  if (!schedule || schedule.status === "CANCELLED" || schedule.status === "COMPLETED") {
    throw new ApiError("Schedule not found.", "PUSH_SCHEDULE_NOT_FOUND", 404);
  }

  // Cancelled, it would never be seeded again — pausing is the off switch.
  if (schedule.automatic && action === "CANCEL") {
    throw new ApiError(
      "An automatic reminder can be paused, not cancelled.",
      "PUSH_SCHEDULE_AUTOMATIC",
      422,
    );
  }

  const set: Record<string, unknown> =
    action === "CANCEL"
      ? { nextRunAt: null, status: "CANCELLED" }
      : action === "PAUSE"
        ? { status: "PAUSED" }
        : (() => {
            // Resuming never replays what was missed while paused.
            const nextRunAt = nextOccurrence(schedule, new Date());

            return nextRunAt
              ? { nextRunAt, status: "ACTIVE" }
              : { nextRunAt: null, status: "COMPLETED" };
          })();

  const updated = await PlatformPushScheduleModel.findByIdAndUpdate(
    id,
    { $set: set },
    { new: true },
  ).lean<ScheduleRecord | null>();

  return { schedule: updated ? serializeSchedule(updated) : null };
}

/**
 * Cron: sends every schedule whose `nextRunAt` has passed.
 *
 * The claim is the advance. `nextRunAt` is moved to the following occurrence
 * with a filter on its old value, so two overlapping runs — the every-minute job
 * and the 15-minute fallback — cannot both win the same send.
 */
export async function dispatchDuePlatformPushes(now = new Date()) {
  await connectToDatabase();
  await ensureAutomaticPushes();

  const due = await PlatformPushScheduleModel.find({
    nextRunAt: { $lte: now },
    status: "ACTIVE",
  })
    .sort({ nextRunAt: 1 })
    .limit(20)
    .lean<ScheduleRecord[]>();

  let sent = 0;
  let skipped = 0;
  let failed = 0;

  for (const schedule of due) {
    const following = nextOccurrence(schedule, now);
    const stale =
      schedule.repeat !== "ONCE" &&
      now.getTime() - (schedule.nextRunAt as Date).getTime() > REPEAT_GRACE_MS;

    const claimed = await PlatformPushScheduleModel.findOneAndUpdate(
      { _id: schedule._id, nextRunAt: schedule.nextRunAt, status: "ACTIVE" },
      {
        $set: {
          nextRunAt: following,
          status: following ? "ACTIVE" : "COMPLETED",
        },
      },
      { new: true },
    ).lean<ScheduleRecord | null>();

    if (!claimed) {
      continue;
    }

    if (stale) {
      skipped += 1;
      continue;
    }

    try {
      const push = schedule.automatic
        ? await deliverAutomatic(schedule.automatic, now)
        : await deliverPush(schedule, String(schedule.createdBy), schedule._id.toString());

      await PlatformPushScheduleModel.updateOne(
        { _id: schedule._id },
        {
          $inc: { runCount: 1 },
          $set: { lastDevices: push.devices, lastRecipients: push.recipients, lastRunAt: now },
        },
      );
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error("[platform-push] scheduled send failed", schedule._id.toString(), error);
    }
  }

  return { due: due.length, failed, sent, skipped };
}

function serializePush(log: PushLogRecord) {
  return {
    audience: log.metadata?.audience ?? "EVERYONE",
    body: log.metadata?.body ?? "",
    devices: log.metadata?.devices ?? 0,
    id: log._id.toString(),
    recipients: log.metadata?.recipients ?? 0,
    scheduled: Boolean(log.metadata?.scheduleId),
    sentAt: new Date(log.createdAt).toISOString(),
    title: log.metadata?.title ?? "",
    urgency: log.metadata?.urgency ?? "NORMAL",
  };
}

function serializeSchedule(schedule: ScheduleRecord) {
  return {
    audience: schedule.audience,
    automatic: schedule.automatic ?? null,
    lastDevices: schedule.lastDevices ?? 0,
    lastRecipients: schedule.lastRecipients ?? 0,
    body: schedule.body,
    endsOn: schedule.endsOn ?? null,
    id: schedule._id.toString(),
    lastRunAt: schedule.lastRunAt ? new Date(schedule.lastRunAt).toISOString() : null,
    nextRunAt: schedule.nextRunAt ? new Date(schedule.nextRunAt).toISOString() : null,
    repeat: schedule.repeat,
    runCount: schedule.runCount ?? 0,
    startsOn: schedule.startsOn,
    status: schedule.status,
    time: schedule.time,
    title: schedule.title,
    urgency: schedule.urgency,
    weekdays: schedule.weekdays ?? [],
  };
}
