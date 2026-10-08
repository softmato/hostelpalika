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
import { assertHostelAccess } from "@/lib/tenant";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { NoticeModel } from "@hostel/db/models/Notice";
import { NoticeReadStatusModel } from "@hostel/db/models/NoticeReadStatus";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";
import {
  findCurrentResident,
  normalizeObjectId,
  serializeResidentSummary,
} from "@/modules/residents/resident-access";
import {
  appUrl,
  getHostelName,
  resolveActiveResidentRecipients,
  sendNotificationEmail,
} from "@/modules/residents/resident-notify";
import { residentNewNoticeEmail } from "@hostel/shared/email/templates/resident/new-notice";
import type {
  noticeCreateSchema,
  noticeListQuerySchema,
  noticeUpdateSchema,
} from "@/modules/notices/notice.validation";

type NoticeCreateInput = z.infer<typeof noticeCreateSchema>;
type NoticeUpdateInput = z.infer<typeof noticeUpdateSchema>;
type NoticeListQuery = z.infer<typeof noticeListQuerySchema>;

type NoticeRecord = {
  _id: Types.ObjectId;
  category: string;
  content: string;
  createdAt?: Date;
  expiresAt?: Date;
  hostelId: Types.ObjectId;
  isUrgent: boolean;
  publishedAt?: Date;
  targetAudience?: "ALL" | "RESIDENTS" | "GUARDIANS";
  title: string;
  updatedAt?: Date;
};

type NoticeReadStatusRecord = {
  _id: Types.ObjectId;
  noticeId: Types.ObjectId;
  readAt: Date;
  userId: Types.ObjectId;
};

export class NoticeServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "NOTICE_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

function normalizeObjectIds(values: string[]) {
  return values.map((value) => normalizeObjectId(value, "hostel id"));
}

export function resolveAdminHostelId(principal: ApiPrincipal, requestedHostelId?: string) {
  if (requestedHostelId) {
    assertHostelAccess(principal, requestedHostelId);
    return normalizeObjectId(requestedHostelId, "hostel id");
  }

  if (principal.hostelIds.length === 1) {
    return normalizeObjectId(principal.hostelIds[0], "hostel id");
  }

  throw new NoticeServiceError(
    "A hostelId is required for this hostel admin action.",
    "HOSTEL_SCOPE_REQUIRED",
    422,
  );
}

export function scopedHostelFilter(principal: ApiPrincipal, requestedHostelId?: string) {
  if (requestedHostelId) {
    return { hostelId: resolveAdminHostelId(principal, requestedHostelId) };
  }

  return {
    hostelId: {
      $in: normalizeObjectIds(principal.hostelIds),
    },
  };
}

function definedUpdate(input: Record<string, unknown>, omittedKeys: string[] = []) {
  return Object.fromEntries(
    Object.entries(input).filter(
      ([key, value]) => value !== undefined && !omittedKeys.includes(key),
    ),
  );
}

function serializeNotice(
  notice: NoticeRecord,
  readStatus?: NoticeReadStatusRecord | null,
) {
  return {
    category: notice.category,
    content: notice.content,
    createdAt: notice.createdAt?.toISOString(),
    expiresAt: notice.expiresAt?.toISOString(),
    hostelId: notice.hostelId.toString(),
    id: notice._id.toString(),
    isRead: Boolean(readStatus),
    isUrgent: notice.isUrgent,
    publishedAt: notice.publishedAt?.toISOString(),
    readAt: readStatus?.readAt.toISOString(),
    targetAudience: notice.targetAudience ?? "ALL",
    title: notice.title,
    updatedAt: notice.updatedAt?.toISOString(),
  };
}

async function auditNoticeAction(
  principal: ApiPrincipal,
  hostelId: Types.ObjectId,
  noticeId: Types.ObjectId,
  action: string,
  metadata: Record<string, unknown> = {},
) {
  await AuditLogModel.create({
    action,
    actorId: principal.userId,
    entityId: noticeId.toString(),
    entityType: "Notice",
    hostelId,
    metadata,
  });
}

export async function createNotice(input: NoticeCreateInput, principal: ApiPrincipal) {
  await connectToDatabase();

  const hostelId = resolveAdminHostelId(principal, input.hostelId);
  const notice = await NoticeModel.create({
    ...input,
    createdBy: principal.userId,
    hostelId,
    publishedAt: input.publishedAt ?? new Date(),
    updatedBy: principal.userId,
  });

  await auditNoticeAction(principal, hostelId, notice._id, "NOTICE_CREATED");

  const delivery = await broadcastNotice(notice as NoticeRecord);

  return {
    delivery,
    notice: serializeNotice(notice as NoticeRecord),
  };
}

/**
 * A push notice going out: a residents' notice on the board, with the push
 * carrying the push notice's own title and message rather than "New notice".
 * No email — a reminder that repeats twice a week is not mail.
 */
export async function publishPushNotice(input: {
  actorId: string;
  body: string;
  expiresAt?: Date;
  hostelId: Types.ObjectId;
  isUrgent: boolean;
  title: string;
}) {
  await connectToDatabase();

  const notice = await NoticeModel.create({
    category: "GENERAL",
    content: input.body,
    createdBy: input.actorId,
    expiresAt: input.expiresAt,
    hostelId: input.hostelId,
    isUrgent: input.isUrgent,
    publishedAt: new Date(),
    targetAudience: "RESIDENTS",
    title: input.title,
    updatedBy: input.actorId,
  });
  const delivery = await broadcastNotice(notice as NoticeRecord, {
    email: false,
    headline: { body: input.body, title: input.title },
  });

  return { delivery, noticeId: notice._id as Types.ObjectId };
}

type BroadcastOptions = {
  email?: boolean;
  /** What the bell row and push say; defaults to "New notice" + the title. */
  headline?: { body: string; title: string };
};

/**
 * Fans a published notice out to the hostel's active residents: an in-app
 * notification always, plus an email for an urgent notice when the platform has
 * notice emails enabled (EMAIL_SYSTEM.md). Everyday notices stay in the bell and
 * the push — a hostel posts several a week, and one email each is a flood.
 * Delivery problems never fail the publish.
 */
async function broadcastNotice(notice: NoticeRecord, options: BroadcastOptions = {}) {
  try {
    return await deliverNoticeBroadcast(notice, options);
  } catch (error) {
    console.warn(
      JSON.stringify({
        level: "warn",
        action: "notice_broadcast_failed",
        message: error instanceof Error ? error.message : "Unknown broadcast error",
        noticeId: notice._id.toString(),
      }),
    );

    return { emailed: 0, notified: 0 };
  }
}

async function deliverNoticeBroadcast(notice: NoticeRecord, options: BroadcastOptions) {
  // A guardians-only notice is not the residents' mail. Guardians read notices
  // by pulling their dashboard, so there is nothing to fan out here.
  if (notice.targetAudience === "GUARDIANS") {
    return { emailed: 0, notified: 0 };
  }

  const config = await getOperationsConfig();
  const [hostelName, recipients] = await Promise.all([
    getHostelName(notice.hostelId),
    resolveActiveResidentRecipients(notice.hostelId),
  ]);
  const email = residentNewNoticeEmail({
    body: notice.content,
    category: notice.category,
    hostelName,
    isUrgent: notice.isUrgent,
    noticesUrl: appUrl("/resident/notices"),
    title: notice.title,
  });

  let emailed = 0;

  for (const recipient of recipients) {
    if (recipient.userId) {
      await createInAppNotification({
        actionUrl: "/resident/notices",
        body: options.headline?.body ?? notice.title,
        category: "NOTICE",
        data: { noticeId: notice._id.toString() },
        hostelId: notice.hostelId.toString(),
        // A notice is an announcement, not a request — NORMAL even when
        // urgent. Urgency rides on `priority`, which is what decides whether
        // the incoming toast pins itself.
        kind: "NORMAL",
        priority: notice.isUrgent ? "URGENT" : "NORMAL",
        title: options.headline?.title ?? (notice.isUrgent ? "Urgent notice" : "New notice"),
        userId: recipient.userId,
      });
    }

    if (!notice.isUrgent || !config.sendNoticeEmails || options.email === false) {
      continue;
    }

    const sent = await sendNotificationEmail({
      action: "resident_new_notice",
      html: email.html,
      subject: email.subject,
      to: recipient.email,
      topic: "NOTICES",
    });

    if (sent) {
      emailed += 1;
    }
  }

  // Everyone in the hostel — residents, guardians, staff — gets the notice
  // board refreshed, not just the recipients who happen to have accounts.
  await publishResourceChange({
    hostelIds: [notice.hostelId.toString()],
    topics: [REALTIME_TOPIC.NOTICES],
  });

  return { emailed, notified: recipients.length };
}

export async function listNotices(query: NoticeListQuery, principal: ApiPrincipal) {
  await connectToDatabase();

  const filter: Record<string, unknown> = {
    ...scopedHostelFilter(principal, query.hostelId),
  };

  if (query.category) {
    filter.category = query.category;
  }

  const { limit, skip } = paginationRange(query);

  const [notices, total] = await Promise.all([
    NoticeModel.find(filter)
      .sort({ isUrgent: -1, publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<NoticeRecord[]>(),
    NoticeModel.countDocuments(filter),
  ]);

  return {
    notices: notices.map((notice) => serializeNotice(notice)),
    pagination: paginationMeta(query, total),
  };
}

export async function updateNotice(
  noticeId: string,
  input: NoticeUpdateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const existingNotice = await NoticeModel.findOne({
    _id: normalizeObjectId(noticeId, "notice id"),
    ...scopedHostelFilter(principal, input.hostelId),
  }).lean<NoticeRecord | null>();

  if (!existingNotice) {
    throw new NoticeServiceError("Notice was not found.", "NOTICE_NOT_FOUND", 404);
  }

  const notice = await NoticeModel.findOneAndUpdate(
    { _id: existingNotice._id },
    {
      $set: {
        ...definedUpdate(input, ["hostelId"]),
        updatedBy: principal.userId,
      },
    },
    { new: true },
  ).lean<NoticeRecord | null>();

  if (!notice) {
    throw new NoticeServiceError("Notice was not found.", "NOTICE_NOT_FOUND", 404);
  }

  await auditNoticeAction(
    principal,
    existingNotice.hostelId,
    existingNotice._id,
    "NOTICE_UPDATED",
  );

  return {
    notice: serializeNotice(notice),
  };
}

/** What a resident's board shows: published, for residents, not expired. */
function residentNoticeFilter(hostelId: Types.ObjectId) {
  return {
    hostelId,
    publishedAt: { $lte: new Date() },
    targetAudience: { $in: ["ALL", "RESIDENTS"] },
    $or: [{ expiresAt: { $exists: false } }, { expiresAt: { $gt: new Date() } }],
  };
}

export async function listNoticesForResident(
  principal: ApiPrincipal,
  query: PaginationQuery = { page: 1, pageSize: MAX_PAGE_SIZE },
) {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);
  const filter = residentNoticeFilter(resident.hostelId);
  const { limit, skip } = paginationRange(query);

  const [notices, total] = await Promise.all([
    NoticeModel.find(filter)
      .sort({ isUrgent: -1, publishedAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<NoticeRecord[]>(),
    NoticeModel.countDocuments(filter),
  ]);
  const readStatuses = await NoticeReadStatusModel.find({
    noticeId: { $in: notices.map((notice) => notice._id) },
    userId: normalizeObjectId(principal.userId, "user id"),
  }).lean<NoticeReadStatusRecord[]>();
  const readStatusByNoticeId = new Map(
    readStatuses.map((status) => [status.noticeId.toString(), status]),
  );

  return {
    notices: notices.map((notice) =>
      serializeNotice(notice, readStatusByNoticeId.get(notice._id.toString())),
    ),
    pagination: paginationMeta(query, total),
    resident: serializeResidentSummary(resident),
  };
}

export async function markNoticeAsRead(noticeId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);
  const notice = await NoticeModel.findOne({
    _id: normalizeObjectId(noticeId, "notice id"),
    hostelId: resident.hostelId,
  }).lean<NoticeRecord | null>();

  if (!notice) {
    throw new NoticeServiceError("Notice was not found.", "NOTICE_NOT_FOUND", 404);
  }

  const readStatus = await NoticeReadStatusModel.findOneAndUpdate(
    {
      noticeId: notice._id,
      userId: normalizeObjectId(principal.userId, "user id"),
    },
    {
      $setOnInsert: {
        readAt: new Date(),
      },
    },
    { new: true, upsert: true },
  ).lean<NoticeReadStatusRecord>();

  return {
    notice: serializeNotice(notice, readStatus),
    resident: serializeResidentSummary(resident),
  };
}

/**
 * Opening the board reads it. Every notice this resident can see is marked read
 * for them in one call, so the Notices badge stops counting the board's whole
 * history just because nobody tapped each card. Only the missing rows are
 * written; a duplicate from a concurrent call (the app and the website at once)
 * is already the answer.
 */
export async function markAllNoticesAsRead(principal: ApiPrincipal) {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);
  const userId = normalizeObjectId(principal.userId, "user id");
  const ids = (await NoticeModel.distinct(
    "_id",
    residentNoticeFilter(resident.hostelId),
  )) as Types.ObjectId[];
  const read = new Set(
    ((await NoticeReadStatusModel.distinct("noticeId", {
      noticeId: { $in: ids },
      userId,
    })) as Types.ObjectId[]).map(String),
  );
  const unread = ids.filter((id) => !read.has(String(id)));

  if (unread.length > 0) {
    const readAt = new Date();

    try {
      await NoticeReadStatusModel.bulkWrite(
        unread.map((noticeId) => ({
          updateOne: {
            filter: { noticeId, userId },
            update: { $setOnInsert: { readAt } },
            upsert: true,
          },
        })),
        { ordered: false },
      );
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) throw error;
    }
  }

  return { marked: unread.length };
}
