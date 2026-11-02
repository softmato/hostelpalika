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
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import {
  publishGlobalAnnouncement,
  publishResourceChange,
} from "@/lib/realtime/server";
import { assertHostelAccess } from "@/lib/tenant";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { GuardianAccessModel } from "@hostel/db/models/GuardianAccess";
import { NotificationCampaignModel } from "@hostel/db/models/NotificationCampaign";
import { NotificationModel } from "@hostel/db/models/Notification";
import { sendPushToUsers } from "@/modules/notifications/push.service";
import { ResidentModel } from "@hostel/db/models/Resident";
import type {
  hostelNotificationCampaignSchema,
  notificationCampaignListQuerySchema,
  platformNotificationCampaignSchema,
} from "@/modules/notifications/notification.validation";

type HostelCampaignInput = z.infer<typeof hostelNotificationCampaignSchema>;
type PlatformCampaignInput = z.infer<typeof platformNotificationCampaignSchema>;
type CampaignListQuery = z.infer<typeof notificationCampaignListQuerySchema>;

type CampaignRecord = {
  _id: Types.ObjectId;
  audience: "ALL" | "RESIDENTS" | "GUARDIANS" | "SPECIFIC";
  body: string;
  category: string;
  createdAt?: Date;
  failureReason?: string;
  hostelId?: Types.ObjectId;
  hostelIds?: Types.ObjectId[];
  priority: "LOW" | "NORMAL" | "HIGH" | "URGENT";
  recipientCount?: number;
  residentIds?: Types.ObjectId[];
  scheduledFor?: Date;
  scope: "HOSTEL" | "PLATFORM";
  sentAt?: Date;
  status: "SCHEDULED" | "SENT" | "CANCELLED" | "FAILED";
  title: string;
};

export class NotificationCampaignError extends Error {
  constructor(
    message: string,
    public errorCode = "NOTIFICATION_CAMPAIGN_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

function normalizeObjectId(value: string, label = "id") {
  if (!Types.ObjectId.isValid(value)) {
    throw new NotificationCampaignError(`Invalid ${label}.`, "INVALID_OBJECT_ID", 422);
  }

  return new Types.ObjectId(value);
}

function serializeCampaign(
  campaign: CampaignRecord,
  stats?: { delivered: number; read: number; sent: number },
) {
  return {
    audience: campaign.audience,
    body: campaign.body,
    category: campaign.category,
    createdAt: campaign.createdAt?.toISOString(),
    failureReason: campaign.failureReason ?? "",
    hostelId: campaign.hostelId?.toString(),
    id: campaign._id.toString(),
    priority: campaign.priority,
    recipientCount: campaign.recipientCount ?? 0,
    scheduledFor: campaign.scheduledFor?.toISOString(),
    scope: campaign.scope,
    sentAt: campaign.sentAt?.toISOString(),
    stats: stats ?? { delivered: 0, read: 0, sent: 0 },
    status: campaign.status,
    title: campaign.title,
  };
}

function resolveHostelId(principal: ApiPrincipal, requestedHostelId?: string) {
  if (requestedHostelId) {
    assertHostelAccess(principal, requestedHostelId);
    return normalizeObjectId(requestedHostelId, "hostel id");
  }

  if (principal.hostelIds.length === 1) {
    return normalizeObjectId(principal.hostelIds[0], "hostel id");
  }

  throw new NotificationCampaignError(
    "A hostelId is required for this action.",
    "HOSTEL_SCOPE_REQUIRED",
    422,
  );
}

/**
 * Resolves a campaign's audience to user ids.
 *
 * Guardians are reached through `GuardianAccess`, which is the row that says a
 * guardian actually has a portal login — a `Guardian` contact record on its own
 * is just a phone number the hostel holds.
 */
async function resolveRecipients(campaign: CampaignRecord): Promise<string[]> {
  const hostelIds =
    campaign.scope === "PLATFORM"
      ? campaign.hostelIds && campaign.hostelIds.length > 0
        ? campaign.hostelIds
        : null
      : campaign.hostelId
        ? [campaign.hostelId]
        : null;

  const residentFilter: Record<string, unknown> = {
    isDeleted: false,
    status: "ACTIVE",
    userId: { $exists: true, $ne: null },
  };

  if (hostelIds) {
    residentFilter.hostelId = { $in: hostelIds };
  }

  if (campaign.audience === "SPECIFIC") {
    residentFilter._id = { $in: campaign.residentIds ?? [] };
  }

  const residents = await ResidentModel.find(residentFilter)
    .select("_id userId")
    .lean<Array<{ _id: Types.ObjectId; userId?: Types.ObjectId }>>();

  if (campaign.audience !== "GUARDIANS") {
    return [
      ...new Set(
        residents
          .map((resident) => resident.userId?.toString())
          .filter((value): value is string => Boolean(value)),
      ),
    ];
  }

  const guardianAccess = await GuardianAccessModel.find({
    residentId: { $in: residents.map((resident) => resident._id) },
    status: "ACTIVE",
  })
    .select("userId")
    .lean<Array<{ userId?: Types.ObjectId }>>();

  return [
    ...new Set(
      guardianAccess
        .map((access) => access.userId?.toString())
        .filter((value): value is string => Boolean(value)),
    ),
  ];
}

/**
 * Writes one receipt per recipient and closes the campaign out.
 *
 * `insertMany` with `ordered: false` so one bad row cannot stop the rest of a
 * broadcast; a campaign that reaches nobody is still marked SENT with a
 * recipient count of 0 rather than retried forever by the cron.
 */
export async function dispatchCampaign(campaign: CampaignRecord) {
  const recipients = await resolveRecipients(campaign);
  const now = new Date();

  if (recipients.length > 0) {
    await NotificationModel.insertMany(
      recipients.map((userId) => ({
        body: campaign.body,
        campaignId: campaign._id,
        category: campaign.category,
        channel: "IN_APP",
        data: { campaignId: campaign._id.toString() },
        deliveredAt: now,
        hostelId: campaign.hostelId,
        priority: campaign.priority,
        status: "SENT",
        title: campaign.title,
        userId,
      })),
      { ordered: false },
    );
  }

  await NotificationCampaignModel.updateOne(
    { _id: campaign._id },
    {
      $set: {
        recipientCount: recipients.length,
        sentAt: now,
        status: "SENT",
      },
    },
  );

  // The rows above go in with `insertMany` rather than one at a time, so none
  // of them produced a per-recipient socket push. The live signal is sent once,
  // here, at the right scope:
  //
  //  - a platform campaign has no hostel and is aimed at everyone, so it goes
  //    out on the global channel as a single broadcast — fanning out one socket
  //    message per recipient is not affordable at that size;
  //  - a hostel campaign goes to that hostel's channel, which reaches exactly
  //    the accounts whose rows were just written.
  if (campaign.hostelId) {
    await publishResourceChange({
      hostelIds: [campaign.hostelId.toString()],
      topics: [REALTIME_TOPIC.NOTIFICATIONS],
    });
  } else {
    await publishGlobalAnnouncement({
      body: campaign.body,
      campaignId: campaign._id.toString(),
      category: campaign.category,
      priority: campaign.priority,
      title: campaign.title,
    });
  }

  /*
   * And the push, to phones and browsers alike.
   *
   * This was missing entirely, and the reason is the `insertMany` above: every
   * other notification in the product is written through
   * `createInAppNotification`, which fans out to the socket *and* to the
   * devices on the way past. Campaigns take the bulk path for the recipient
   * counts they have to handle, and in doing so skipped the only thing that
   * reaches somebody who is not currently looking at the app.
   *
   * So the deliberate broadcast channel — the one an admin uses precisely when
   * everybody needs to know something — was the single channel in the product
   * that could not interrupt anyone. It landed in the bell and waited.
   *
   * One call for the whole audience rather than one per recipient:
   * `sendPushToUsers` already applies preferences and quiet hours in a single
   * query, batches Expo at its 100-per-request cap and bounds the browser sends,
   * which is exactly the shape a broadcast needs.
   */
  if (recipients.length > 0) {
    await sendPushToUsers(recipients, {
      body: campaign.body,
      category: campaign.category,
      data: { campaignId: campaign._id.toString() },
      hostelId: campaign.hostelId?.toString(),
      priority: campaign.priority,
      title: campaign.title,
    });
  }

  return { recipientCount: recipients.length };
}

async function createCampaign(
  document: Record<string, unknown>,
  principal: ApiPrincipal,
  scheduledFor?: Date,
) {
  const now = new Date();

  if (scheduledFor && scheduledFor.getTime() < now.getTime() - 60_000) {
    throw new NotificationCampaignError(
      "Pick a delivery time in the future.",
      "NOTIFICATION_SCHEDULE_IN_PAST",
      422,
    );
  }

  const campaign = (await NotificationCampaignModel.create({
    ...document,
    createdBy: principal.userId,
    scheduledFor,
    status: "SCHEDULED",
  })) as CampaignRecord;

  // No schedule means send now, in the same request, so the admin sees the
  // recipient count immediately instead of waiting on the cron.
  const dispatched = scheduledFor ? null : await dispatchCampaign(campaign);

  await AuditLogModel.create({
    action: "NOTIFICATION_CAMPAIGN_CREATED",
    actorId: principal.userId,
    entityId: campaign._id.toString(),
    entityType: "NotificationCampaign",
    hostelId: campaign.hostelId,
    metadata: {
      audience: campaign.audience,
      recipientCount: dispatched?.recipientCount ?? 0,
      scheduled: Boolean(scheduledFor),
    },
  });

  const saved = await NotificationCampaignModel.findById(
    campaign._id,
  ).lean<CampaignRecord | null>();

  return { campaign: serializeCampaign(saved ?? campaign) };
}

export async function createHostelNotificationCampaign(
  input: HostelCampaignInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const hostelId = resolveHostelId(principal, input.hostelId);

  return createCampaign(
    {
      audience: input.audience,
      body: input.body,
      category: input.category,
      hostelId,
      priority: input.priority,
      residentIds: input.residentIds.map((id) => normalizeObjectId(id, "resident id")),
      scope: "HOSTEL",
      title: input.title,
    },
    principal,
    input.scheduledFor,
  );
}

export async function createPlatformNotificationCampaign(
  input: PlatformCampaignInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  return createCampaign(
    {
      audience: "ALL",
      body: input.body,
      category: input.category,
      hostelIds: input.hostelIds.map((id) => normalizeObjectId(id, "hostel id")),
      priority: input.priority,
      scope: "PLATFORM",
      title: input.title,
    },
    principal,
    input.scheduledFor,
  );
}

/** Delivered/read counts per campaign, read from the receipts themselves. */
async function statsForCampaigns(campaignIds: Types.ObjectId[]) {
  if (campaignIds.length === 0) {
    return new Map<string, { delivered: number; read: number; sent: number }>();
  }

  const rows = await NotificationModel.aggregate<{
    _id: Types.ObjectId;
    delivered: number;
    read: number;
    sent: number;
  }>([
    { $match: { campaignId: { $in: campaignIds } } },
    {
      $group: {
        _id: "$campaignId",
        delivered: {
          $sum: { $cond: [{ $gt: ["$deliveredAt", null] }, 1, 0] },
        },
        read: { $sum: { $cond: [{ $gt: ["$readAt", null] }, 1, 0] } },
        sent: { $sum: 1 },
      },
    },
  ]);

  return new Map(
    rows.map((row) => [
      row._id.toString(),
      { delivered: row.delivered, read: row.read, sent: row.sent },
    ]),
  );
}

export async function listHostelNotificationCampaigns(
  query: CampaignListQuery,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const hostelIds = query.hostelId
    ? [resolveHostelId(principal, query.hostelId)]
    : principal.hostelIds.map((id) => normalizeObjectId(id, "hostel id"));

  const filter = { hostelId: { $in: hostelIds } };
  const { limit, skip } = paginationRange(query);

  const [campaigns, total] = await Promise.all([
    NotificationCampaignModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<CampaignRecord[]>(),
    NotificationCampaignModel.countDocuments(filter),
  ]);
  const stats = await statsForCampaigns(campaigns.map((campaign) => campaign._id));

  return {
    campaigns: campaigns.map((campaign) =>
      serializeCampaign(campaign, stats.get(campaign._id.toString())),
    ),
    pagination: paginationMeta(query, total),
  };
}

export async function listPlatformNotificationCampaigns(
  query: PaginationQuery = { page: 1, pageSize: MAX_PAGE_SIZE },
) {
  await connectToDatabase();

  const filter = { scope: "PLATFORM" };
  const { limit, skip } = paginationRange(query);

  const [campaigns, total] = await Promise.all([
    NotificationCampaignModel.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .lean<CampaignRecord[]>(),
    NotificationCampaignModel.countDocuments(filter),
  ]);
  const stats = await statsForCampaigns(campaigns.map((campaign) => campaign._id));

  return {
    campaigns: campaigns.map((campaign) =>
      serializeCampaign(campaign, stats.get(campaign._id.toString())),
    ),
    pagination: paginationMeta(query, total),
  };
}

/**
 * Cron entry point: dispatches every scheduled campaign whose time has passed.
 *
 * A campaign is claimed by flipping it out of SCHEDULED before its receipts are
 * written, so two overlapping cron runs cannot double-send. A campaign that
 * throws is marked FAILED with the reason rather than left to retry forever.
 */
export async function dispatchDueCampaigns(now = new Date()) {
  await connectToDatabase();

  const due = await NotificationCampaignModel.find({
    scheduledFor: { $lte: now },
    status: "SCHEDULED",
  })
    .sort({ scheduledFor: 1 })
    .limit(50)
    .lean<CampaignRecord[]>();

  let dispatched = 0;
  let failed = 0;
  let recipients = 0;

  for (const campaign of due) {
    const claimed = await NotificationCampaignModel.findOneAndUpdate(
      { _id: campaign._id, status: "SCHEDULED" },
      { $set: { status: "SENT", sentAt: now } },
      { new: true },
    ).lean<CampaignRecord | null>();

    if (!claimed) {
      continue;
    }

    try {
      const result = await dispatchCampaign(campaign);

      dispatched += 1;
      recipients += result.recipientCount;
    } catch (error) {
      failed += 1;
      await NotificationCampaignModel.updateOne(
        { _id: campaign._id },
        {
          $set: {
            failureReason:
              error instanceof Error ? error.message : "Unknown dispatch error",
            status: "FAILED",
          },
        },
      );
    }
  }

  return { dispatched, failed, recipients, scanned: due.length };
}
