import { Types } from "mongoose";
import { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { FeedbackModel } from "@hostel/db/models/Feedback";
import { FileAssetModel } from "@hostel/db/models/FileAsset";
import { HostelModel } from "@hostel/db/models/Hostel";
import { UserModel } from "@hostel/db/models/User";

/**
 * Help & support → Send feedback, from every portal on the web and in the app.
 * One text box (its first line reads as the title), a kind, and up to four
 * screenshots the sender uploaded first. Platform staff read and close them
 * in Platform → Feedback.
 */

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id.");

export const feedbackCreateSchema = z.object({
  appVersion: z.string().trim().max(40).optional(),
  kind: z.enum(["FEEDBACK", "BUG", "IMPROVEMENT"]),
  message: z.string().trim().min(3, "Write a few words.").max(4000),
  page: z.string().trim().max(300).optional(),
  platform: z.enum(["WEB", "APP"]).default("WEB"),
  screenshotAssetIds: z.array(objectId).max(4).default([]),
});

export const feedbackStatusSchema = z.object({ status: z.enum(["NEW", "SEEN", "DONE"]) });

/** Per-sender budget, counted in the database so every serverless instance agrees. */
export const FEEDBACK_PER_HOUR = 5;
export const FEEDBACK_PER_DAY = 15;

/** True when this user has used up their hourly or daily feedback budget. */
export async function feedbackQuotaReached(userId: string) {
  await connectToDatabase();

  const now = Date.now();
  const userObjectId = new Types.ObjectId(userId);
  const [lastHour, lastDay] = await Promise.all([
    FeedbackModel.countDocuments({ createdAt: { $gte: new Date(now - 60 * 60 * 1000) }, userId: userObjectId }),
    FeedbackModel.countDocuments({ createdAt: { $gte: new Date(now - 24 * 60 * 60 * 1000) }, userId: userObjectId }),
  ]);

  return lastHour >= FEEDBACK_PER_HOUR || lastDay >= FEEDBACK_PER_DAY;
}

export async function createFeedback(principal: ApiPrincipal, input: z.infer<typeof feedbackCreateSchema>) {
  await connectToDatabase();

  // Only the sender's own uploads ride along; anything else is dropped, not trusted.
  const owned = input.screenshotAssetIds.length
    ? await FileAssetModel.find({
        _id: { $in: input.screenshotAssetIds.map((id) => new Types.ObjectId(id)) },
        ownerId: new Types.ObjectId(principal.userId),
      })
        .select("_id")
        .lean<Array<{ _id: Types.ObjectId }>>()
    : [];

  const created = await FeedbackModel.create({
    appVersion: input.appVersion,
    hostelId: principal.hostelIds[0] ? new Types.ObjectId(principal.hostelIds[0]) : undefined,
    kind: input.kind,
    message: input.message,
    page: input.page,
    platform: input.platform,
    role: principal.role,
    screenshotAssetIds: owned.map((asset) => asset._id),
    userId: new Types.ObjectId(principal.userId),
  });

  return { id: String(created._id) };
}

type FeedbackRecord = {
  _id: Types.ObjectId;
  appVersion?: string;
  createdAt: Date;
  hostelId?: Types.ObjectId;
  kind: string;
  message: string;
  page?: string;
  platform?: string;
  role?: string;
  screenshotAssetIds?: Types.ObjectId[];
  status: string;
  userId: Types.ObjectId;
};

/**
 * The platform inbox, newest first; `status` and `role` narrow it. Status counts
 * follow the role picked and role counts follow the status tab, so each row of
 * chips reads as "how many of these are in what I'm looking at".
 */
export async function listFeedback(status?: string, role?: string) {
  await connectToDatabase();

  const statusFilter = status ? { status } : {};
  const roleFilter = role ? { role } : {};
  const rows = await FeedbackModel.find({ ...statusFilter, ...roleFilter })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean<FeedbackRecord[]>();
  const [users, hostels, counts, roleCounts, assets] = await Promise.all([
    UserModel.find({ _id: { $in: rows.map((row) => row.userId) } })
      .select("name fullName email phone")
      .lean<Array<{ _id: Types.ObjectId; email?: string; fullName?: string; name?: string; phone?: string }>>(),
    HostelModel.find({ _id: { $in: rows.map((row) => row.hostelId).filter(Boolean) } })
      .select("name")
      .lean<Array<{ _id: Types.ObjectId; name: string }>>(),
    FeedbackModel.aggregate<{ _id: string; count: number }>([
      { $match: roleFilter },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    FeedbackModel.aggregate<{ _id: string | null; count: number }>([
      { $match: statusFilter },
      { $group: { _id: "$role", count: { $sum: 1 } } },
    ]),
    // Attachments can be clips as well as screenshots; the inbox plays those.
    FileAssetModel.find({ _id: { $in: rows.flatMap((row) => row.screenshotAssetIds ?? []) } })
      .select("mimeType")
      .lean<Array<{ _id: Types.ObjectId; mimeType: string }>>(),
  ]);
  const videoIds = new Set(
    assets.filter((asset) => asset.mimeType.startsWith("video/")).map((asset) => String(asset._id)),
  );
  const userById = new Map(users.map((user) => [String(user._id), user]));
  const hostelById = new Map(hostels.map((hostel) => [String(hostel._id), hostel.name]));

  return {
    counts: Object.fromEntries(counts.map((entry) => [entry._id, entry.count])) as Record<string, number>,
    roleCounts: Object.fromEntries(roleCounts.map((entry) => [entry._id ?? "UNKNOWN", entry.count])) as Record<string, number>,
    items: rows.map((row) => {
      const user = userById.get(String(row.userId));

      return {
        appVersion: row.appVersion ?? null,
        createdAt: row.createdAt.toISOString(),
        hostel: row.hostelId ? (hostelById.get(String(row.hostelId)) ?? null) : null,
        id: String(row._id),
        kind: row.kind,
        message: row.message,
        page: row.page ?? null,
        platform: row.platform ?? "WEB",
        role: row.role ?? null,
        screenshots: (row.screenshotAssetIds ?? []).map((assetId) => ({
          id: String(assetId),
          video: videoIds.has(String(assetId)),
        })),
        sender: {
          email: user?.email ?? null,
          name: user?.fullName ?? user?.name ?? "Unknown",
          phone: user?.phone ?? null,
        },
        status: row.status,
      };
    }),
  };
}

export async function setFeedbackStatus(id: string, status: "NEW" | "SEEN" | "DONE", actorId: string) {
  await connectToDatabase();

  await FeedbackModel.updateOne(
    { _id: new Types.ObjectId(objectId.parse(id)) },
    { $set: { handledAt: new Date(), handledBy: new Types.ObjectId(actorId), status } },
  );

  return { id, status };
}
