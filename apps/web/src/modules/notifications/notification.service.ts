import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import {
  MAX_PAGE_SIZE,
  paginationMeta,
  paginationRange,
  type PaginationQuery,
} from "@/lib/pagination";
import { DeviceTokenModel } from "@hostel/db/models/DeviceToken";
import { NotificationModel } from "@hostel/db/models/Notification";
import { topicsForCategory } from "@/lib/realtime/channels";
import {
  publishNotification,
  publishNotificationUpdated,
  publishResourceChange,
} from "@/lib/realtime/server";
import { normalizeObjectId } from "@/modules/residents/resident-access";
import { dispatchPush } from "@/modules/notifications/push.service";
import type {
  deviceTokenRevokeSchema,
  deviceTokenSaveSchema,
} from "@/modules/notifications/notification.validation";

type DeviceTokenSaveInput = z.infer<typeof deviceTokenSaveSchema>;
type DeviceTokenRevokeInput = z.infer<typeof deviceTokenRevokeSchema>;

export type NotificationKind = "NORMAL" | "ACTION";
export type NotificationActionState = "PENDING" | "COMPLETED" | "DISMISSED";

export type NotificationAction = {
  endpoint: string;
  key: string;
  label: string;
  method?: "POST" | "PATCH" | "PUT" | "DELETE";
  payload?: Record<string, unknown>;
  tone?: "default" | "primary" | "danger";
};

type NotificationRecord = {
  _id: Types.ObjectId;
  actions?: NotificationAction[];
  actionState?: NotificationActionState;
  actionTakenAt?: Date;
  actionTakenKey?: string;
  actionUrl?: string;
  body: string;
  category: string;
  channel: "IN_APP" | "PUSH" | "EMAIL" | "SMS";
  createdAt?: Date;
  data?: Record<string, unknown>;
  hostelId?: Types.ObjectId;
  kind?: NotificationKind;
  priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  readAt?: Date;
  status: "QUEUED" | "SENT" | "FAILED";
  title: string;
  userId: Types.ObjectId;
};

export class NotificationServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "NOTIFICATION_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

function serializeNotification(notification: NotificationRecord) {
  const kind: NotificationKind = notification.kind ?? "NORMAL";

  return {
    // Only ACTION rows carry buttons; sending an empty array for the rest keeps
    // the client from having to special-case `undefined`.
    actions: kind === "ACTION" ? (notification.actions ?? []) : [],
    actionState: notification.actionState ?? "PENDING",
    actionTakenAt: notification.actionTakenAt?.toISOString(),
    actionTakenKey: notification.actionTakenKey,
    actionUrl: notification.actionUrl,
    body: notification.body,
    category: notification.category,
    channel: notification.channel,
    createdAt: notification.createdAt?.toISOString(),
    data: notification.data ?? {},
    hostelId: notification.hostelId?.toString(),
    id: notification._id.toString(),
    isRead: Boolean(notification.readAt),
    kind,
    /** True while this row is still waiting on the recipient to decide. */
    needsAction:
      kind === "ACTION" && (notification.actionState ?? "PENDING") === "PENDING",
    priority: notification.priority ?? "NORMAL",
    readAt: notification.readAt?.toISOString(),
    status: notification.status,
    title: notification.title,
    userId: notification.userId.toString(),
  };
}

export type SerializedNotification = ReturnType<typeof serializeNotification>;

/**
 * Read a freshly created document as a plain record.
 *
 * `NotificationModel.create` hands back a hydrated Mongoose document, but the
 * unit tests substitute plain objects for the model — so this only calls
 * `toObject` when it is actually there rather than assuming a real document.
 */
function asRecord(document: unknown): NotificationRecord {
  const candidate = document as { toObject?: () => unknown };

  return (
    typeof candidate?.toObject === "function" ? candidate.toObject() : document
  ) as NotificationRecord;
}

/**
 * Fan one freshly written row out to every live surface: the recipient's
 * socket (open tab or foregrounded app), the panels its category implies, and
 * their phones.
 *
 * This is the *only* place delivery happens, which is what keeps the three
 * channels from drifting — a caller writes a notification and all three follow.
 * Adding a push at each call site instead would guarantee that some of them
 * eventually forgot.
 *
 * Wholly best-effort: the notification is already committed by the time this
 * runs, so nothing in here — a serialisation problem, an unreachable Pusher,
 * a dead Expo endpoint — is allowed to propagate. The worst case is that the
 * recipient sees the row on their next poll instead of instantly.
 */
/**
 * The two deliveries a fresh row makes, and why only one of them is optional.
 *
 * `push` gates the Expo send **and nothing else**. It used to gate this whole
 * function, which meant a caller batching its own push — `notifyOrderPlaced`,
 * `announceFoodReady` — was also, silently, turning off that recipient's live
 * bell and the topic invalidation behind it. The bell then sat at its old count
 * until something unrelated refreshed it, for exactly the events important
 * enough to have been given a hand-written payload.
 *
 * So the socket and the topic fan-out always run. The push is skipped only when
 * a caller has said it will send a better one, for the whole audience at once.
 */
async function publishNewNotification(
  userId: string,
  document: unknown,
  category: string,
  imageUrl?: string,
  options: { push?: boolean } = {},
) {
  const record = asRecord(document);

  if (options.push !== false) {
    // Not awaited — but not abandoned either. An Expo round trip can take
    // seconds and a user is waiting on the request that created this row, so
    // `dispatchPush` hands the send to `after()`: off the response's critical
    // path, and still alive once the response has gone.
    dispatchPush([userId], {
      actionUrl: record.actionUrl,
      body: record.body,
      category,
      data: record.data,
      hostelId: record.hostelId?.toString(),
      imageUrl,
      notificationId: record._id?.toString(),
      priority: record.priority,
      title: record.title,
    });
  }

  try {
    await publishNotification(userId, serializeNotification(record));

    const topics = topicsForCategory(category);

    if (topics.length > 0) {
      await publishResourceChange({ topics, userIds: [userId] });
    }
  } catch {
    // Delivery is durable in Mongo; the live push is an optimisation.
  }
}

export async function createInAppNotification(input: {
  /** Inline buttons for ACTION rows. Ignored when `kind` is NORMAL. */
  actions?: NotificationAction[];
  /** Deep link to the screen that resolves this. Implies `kind: "ACTION"`. */
  actionUrl?: string;
  body: string;
  category: string;
  createdBy?: string;
  data?: Record<string, unknown>;
  hostelId?: string;
  imageUrl?: string;
  kind?: NotificationKind;
  /**
   * Let a caller pair the durable bell row with its own richer push payload.
   * `false` suppresses **only** the per-row Expo send — the live bell and the
   * topic fan-out still happen, because a caller batching a push has not asked
   * to go quiet everywhere else.
   */
  push?: boolean;
  priority?: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  title: string;
  userId: string;
}) {
  await connectToDatabase();

  // Callers that pass a destination or buttons mean "someone must deal with
  // this", so they do not also have to remember to set `kind`.
  const kind: NotificationKind =
    input.kind ?? (input.actionUrl || input.actions?.length ? "ACTION" : "NORMAL");

  const notification = await NotificationModel.create({
    actions: kind === "ACTION" ? input.actions : undefined,
    actionState: "PENDING",
    actionUrl: input.actionUrl,
    body: input.body,
    category: input.category,
    channel: "IN_APP",
    createdBy: input.createdBy,
    data: input.data,
    hostelId: input.hostelId,
    kind,
    priority: input.priority,
    status: "SENT",
    title: input.title,
    userId: input.userId,
  });

  await publishNewNotification(
    input.userId,
    notification,
    input.category,
    input.imageUrl,
    { push: input.push },
  );

  return notification;
}

/**
 * Collapse repeated notifications about the same thing into one row.
 *
 * Anything that can fire many times in a row for a single recipient — reactions
 * on one post, say — would otherwise flood the bell with near-identical rows.
 * Instead the first event writes a notification carrying a `dedupeKey`, and
 * every later event for the same key rewrites that same row's title/body and
 * bumps it back to the top of the feed.
 *
 * Only *unread* rows are reused. Once the author has read "5 people reacted",
 * the next reaction writes a fresh row, so they are told about it rather than
 * having an already-seen notification silently mutate behind them.
 */
export async function createOrUpdateBatchedNotification(input: {
  body: string;
  category: string;
  data?: Record<string, unknown>;
  /** Identifies the thing being batched, e.g. `reaction:<postId>`. */
  dedupeKey: string;
  hostelId?: string;
  title: string;
  userId: string;
}) {
  await connectToDatabase();

  const now = new Date();
  const existing = await NotificationModel.findOneAndUpdate(
    {
      category: input.category,
      "data.dedupeKey": input.dedupeKey,
      readAt: { $exists: false },
      userId: normalizeObjectId(input.userId, "user id"),
    },
    {
      $set: {
        body: input.body,
        createdAt: now,
        data: { ...input.data, dedupeKey: input.dedupeKey },
        title: input.title,
      },
    },
    { new: true },
  );

  if (existing) {
    // Re-push the rewritten row so an open bell shows "5 people reacted"
    // replacing "4 people reacted" rather than waiting for its next poll.
    await publishNewNotification(input.userId, existing, input.category);

    return existing;
  }

  return createInAppNotification({
    body: input.body,
    category: input.category,
    data: { ...input.data, dedupeKey: input.dedupeKey },
    hostelId: input.hostelId,
    title: input.title,
    userId: input.userId,
  });
}

export type NotificationFilter = "all" | "unread" | "action";

export async function listNotifications(
  principal: ApiPrincipal,
  query: PaginationQuery = { page: 1, pageSize: MAX_PAGE_SIZE },
  filterBy: NotificationFilter = "all",
) {
  await connectToDatabase();

  const mine = { userId: normalizeObjectId(principal.userId, "user id") };
  const unreadFilter = { ...mine, readAt: { $exists: false } };
  // "Needs action" is not "unread": an admin can read "a hostel is waiting for
  // approval" and still not have approved it, so this queue keys off
  // `actionState`, not the read receipt.
  const actionFilter = { ...mine, actionState: "PENDING", kind: "ACTION" };

  const filter =
    filterBy === "unread" ? unreadFilter : filterBy === "action" ? actionFilter : mine;

  const { limit, skip } = paginationRange(query);

  const [notifications, total, unread, pendingActions] = await Promise.all([
    NotificationModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<NotificationRecord[]>(),
    NotificationModel.countDocuments(filter),
    // The bell badge counts every unread notification, not the unread ones on
    // this page.
    NotificationModel.countDocuments(unreadFilter),
    NotificationModel.countDocuments(actionFilter),
  ]);

  return {
    actionCount: pendingActions,
    notifications: notifications.map(serializeNotification),
    pagination: paginationMeta(query, total),
    unreadCount: unread,
  };
}

export async function markNotificationRead(
  notificationId: string,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const notification = await NotificationModel.findOneAndUpdate(
    {
      _id: normalizeObjectId(notificationId, "notification id"),
      userId: normalizeObjectId(principal.userId, "user id"),
    },
    { $set: { readAt: new Date(), updatedBy: principal.userId } },
    { new: true },
  ).lean<NotificationRecord | null>();

  if (!notification) {
    throw new NotificationServiceError(
      "Notification was not found.",
      "NOTIFICATION_NOT_FOUND",
      404,
    );
  }

  await publishNotificationUpdated(principal.userId, notificationId);

  return {
    notification: serializeNotification(notification),
  };
}

/** Clear the whole unread badge in one call, for the bell's "Mark all read". */
export async function markAllNotificationsRead(principal: ApiPrincipal) {
  await connectToDatabase();

  const result = await NotificationModel.updateMany(
    {
      readAt: { $exists: false },
      userId: normalizeObjectId(principal.userId, "user id"),
    },
    { $set: { readAt: new Date(), updatedBy: principal.userId } },
  );

  await publishNotificationUpdated(principal.userId, "all");

  return { markedRead: result.modifiedCount ?? 0 };
}

/**
 * Settle the night prompt's bell rows once the resident has an answer, from
 * whichever surface — the shade, the bell, the screen, the web or a warden's
 * override — so the row shows that answer instead of sitting in "Needs action".
 *
 * Tonight's row is rewritten on every answer, not only the first, so it always
 * shows the current one. An older night's row can no longer be answered and is
 * dismissed.
 */
export async function settleNightStatusNotifications(
  userId: string,
  night: string,
  answer: { note?: string; reasonCode?: string; status: string },
) {
  const now = new Date();
  const mine = {
    category: "NIGHT_STATUS",
    kind: "ACTION",
    userId: normalizeObjectId(userId, "user id"),
  };
  const [tonight, older] = await Promise.all([
    NotificationModel.updateMany(
      { ...mine, "data.night": night },
      {
        $set: {
          actionState: "COMPLETED",
          actionTakenAt: now,
          actionTakenKey: answer.status,
          "data.answer": answer,
          readAt: now,
        },
      },
    ),
    NotificationModel.updateMany(
      { ...mine, actionState: "PENDING", "data.night": { $ne: night } },
      { $set: { actionState: "DISMISSED", actionTakenAt: now, readAt: now } },
    ),
  ]);

  if (tonight.modifiedCount + older.modifiedCount > 0) {
    await publishNotificationUpdated(userId, "all");
  }
}

/**
 * Take one request out of "Needs action" for everyone it went to, once anybody
 * has answered it. A khata request goes to every warden and the owner; when one
 * of them approves it, it is not still waiting on the rest. `data` names the
 * request (`{ type, residentId }`), so only that request's rows move.
 */
export async function settleActionNotifications(
  match: { category: string; data: Record<string, string> },
  actionKey: string,
) {
  await connectToDatabase();

  const filter: Record<string, unknown> = {
    actionState: "PENDING",
    category: match.category,
    kind: "ACTION",
  };
  for (const [key, value] of Object.entries(match.data)) filter[`data.${key}`] = value;

  const userIds: Types.ObjectId[] = await NotificationModel.distinct("userId", filter);
  if (userIds.length === 0) return;

  const now = new Date();
  await NotificationModel.updateMany(filter, {
    $set: { actionState: "COMPLETED", actionTakenAt: now, actionTakenKey: actionKey, readAt: now },
  });
  await Promise.all(userIds.map((userId) => publishNotificationUpdated(String(userId), "all")));
}

/**
 * Record that an ACTION notification has been dealt with.
 *
 * This only moves the notification out of the "Needs action" queue — the actual
 * work (approving the hostel, rejecting the application) is done by that
 * domain's own endpoint, which the bell calls first. Keeping the two separate
 * means the queue can be cleared for a request that was resolved from the full
 * admin panel instead of the bell, and no permission decision is ever made
 * here: this route can only ever touch the caller's own rows.
 */
export async function resolveNotificationAction(
  notificationId: string,
  principal: ApiPrincipal,
  input: { actionKey?: string; state?: Exclude<NotificationActionState, "PENDING"> },
) {
  await connectToDatabase();

  const now = new Date();
  const notification = await NotificationModel.findOneAndUpdate(
    {
      _id: normalizeObjectId(notificationId, "notification id"),
      kind: "ACTION",
      userId: normalizeObjectId(principal.userId, "user id"),
    },
    {
      $set: {
        actionState: input.state ?? "COMPLETED",
        actionTakenAt: now,
        actionTakenKey: input.actionKey,
        // Answering a request is a stronger signal than opening it, so this
        // marks it read as well rather than leaving a stale unread badge.
        readAt: now,
        updatedBy: principal.userId,
      },
    },
    { new: true },
  ).lean<NotificationRecord | null>();

  if (!notification) {
    throw new NotificationServiceError(
      "Notification was not found.",
      "NOTIFICATION_NOT_FOUND",
      404,
    );
  }

  await publishNotificationUpdated(principal.userId, notificationId);

  return { notification: serializeNotification(notification) };
}

export async function saveDeviceToken(
  input: DeviceTokenSaveInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const token = await DeviceTokenModel.findOneAndUpdate(
    { token: input.token },
    {
      $set: {
        // Replaced, not merged: an older build re-registering the same token
        // must lose what a newer one declared.
        capabilities: input.capabilities ?? [],
        deviceId: input.deviceId,
        lastSeenAt: new Date(),
        platform: input.platform,
        status: "ACTIVE",
        userId: principal.userId,
      },
    },
    { new: true, upsert: true },
  ).lean<{
    _id: Types.ObjectId;
    deviceId?: string;
    lastSeenAt: Date;
    platform: string;
    status: string;
    token: string;
    userId: Types.ObjectId;
  }>();

  if (!token) {
    throw new NotificationServiceError(
      "Device token could not be saved.",
      "DEVICE_TOKEN_SAVE_FAILED",
      500,
    );
  }

  return {
    deviceToken: {
      deviceId: token.deviceId ?? "",
      id: token._id.toString(),
      lastSeenAt: token.lastSeenAt.toISOString(),
      platform: token.platform,
      status: token.status,
      token: token.token,
      userId: token.userId.toString(),
    },
  };
}

/**
 * Stops delivery to one device, on sign-out.
 *
 * ## The leak this closes
 *
 * `saveDeviceToken` upserts on the **token** and stamps the caller's `userId`,
 * which is right — a phone must only ever be attributed to whoever is signed in
 * on it. But nothing ever cleared the attribution. Signing out only forgot the
 * token *locally*, so the row stayed `ACTIVE` against the previous account and
 * that person's invoices, complaint replies and SOS alerts kept arriving on a
 * handset they had signed out of, indefinitely — on a shared or handed-down
 * phone, to whoever was holding it. Nothing pruned it either: Expo only reports
 * `DeviceNotRegistered` for a token the *app* no longer holds, and this one was
 * still perfectly valid.
 *
 * ## Scoped to the caller, not to the token
 *
 * The filter carries `userId`, so a token belonging to someone else cannot be
 * revoked by quoting it. Push tokens travel — they are posted by the client and
 * are not secret — and without the scope this route would be a way to silence
 * any device whose token had been observed.
 *
 * ## `REVOKED`, not deleted, and never an error
 *
 * Same reasoning as the `DeviceNotRegistered` pruning in `push.service.ts`: the
 * row is the record that this device existed, and `account-purge` owns removal.
 * A token that matches nothing answers success — the caller is signing out, the
 * device is not receiving, and the desired state holds. Reporting a failure
 * there would only give sign-out a way to fail for a reason nobody can act on.
 */
export async function revokeDeviceToken(
  input: DeviceTokenRevokeInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const result = await DeviceTokenModel.updateMany(
    { token: input.token, userId: principal.userId },
    { $set: { status: "REVOKED" } },
  );

  return { revoked: result.modifiedCount ?? 0 };
}
