import { createHash, randomBytes } from "node:crypto";

import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelPageViewModel } from "@hostel/db/models/HostelPageView";
import { HostelServiceError } from "@/modules/hostels/hostel.service";
import { evaluateProfilePrompt } from "@/modules/users/resident-identity.service";

/** Cookie holding an opaque per-browser id. Not personal data, not readable by JS. */
export const VISITOR_COOKIE = "hh_visitor";
export const VISITOR_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * A refresh, a back-navigation or a second look within this window counts once.
 * Without it the admin's "page views" number would mostly measure reloads.
 */
const DEDUPE_WINDOW_MINUTES = 30;

type HostelRef = {
  _id: Types.ObjectId;
  name: string;
  publicViewCount?: number;
  slug: string;
};

export function newVisitorKey() {
  return randomBytes(16).toString("hex");
}

/** Accepts an existing cookie value, or mints one. Hashed so logs stay clean. */
export function resolveVisitorKey(cookieValue?: string | null) {
  if (cookieValue && /^[a-f\d]{32}$/i.test(cookieValue)) {
    return { isNew: false, visitorKey: cookieValue };
  }

  return { isNew: true, visitorKey: newVisitorKey() };
}

function hashUserAgent(userAgent?: string | null) {
  if (!userAgent) {
    return undefined;
  }

  // Kept only as a coarse bot/device signal; never stored raw.
  return createHash("sha256").update(userAgent).digest("hex").slice(0, 32);
}

export async function recordHostelPageView(input: {
  hostelRef: string;
  referrer?: string | null;
  userAgent?: string | null;
  userId?: string;
  visitorKey: string;
}) {
  await connectToDatabase();

  const lookup = Types.ObjectId.isValid(input.hostelRef)
    ? { _id: new Types.ObjectId(input.hostelRef) }
    : { slug: input.hostelRef };

  const hostel = await HostelModel.findOne({
    ...lookup,
    isDeleted: false,
    status: "PUBLISHED",
    verificationStatus: "VERIFIED",
  })
    .select("name publicViewCount slug")
    .lean<HostelRef | null>();

  if (!hostel) {
    throw new HostelServiceError("Hostel was not found.", "HOSTEL_NOT_FOUND", 404);
  }

  const since = new Date(Date.now() - DEDUPE_WINDOW_MINUTES * 60 * 1000);
  const recentView = await HostelPageViewModel.findOne({
    createdAt: { $gte: since },
    hostelId: hostel._id,
    visitorKey: input.visitorKey,
  })
    .select("_id")
    .lean<{ _id: Types.ObjectId } | null>();

  let counted = false;

  if (!recentView) {
    await HostelPageViewModel.create({
      hostelId: hostel._id,
      referrer: input.referrer?.slice(0, 300) ?? undefined,
      userAgent: hashUserAgent(input.userAgent),
      userId:
        input.userId && Types.ObjectId.isValid(input.userId)
          ? new Types.ObjectId(input.userId)
          : null,
      visitorKey: input.visitorKey,
    });

    await HostelModel.updateOne({ _id: hostel._id }, { $inc: { publicViewCount: 1 } });
    counted = true;
  }

  const prompt = await evaluateProfilePrompt({
    userId: input.userId,
    visitorKey: input.visitorKey,
  });

  return {
    counted,
    hostelId: hostel._id.toString(),
    prompt,
    viewCount: (hostel.publicViewCount ?? 0) + (counted ? 1 : 0),
  };
}

/**
 * Listing analytics for the hostel admin dashboard: the lifetime total plus the
 * two numbers an owner actually acts on — how many distinct people looked, and
 * how much traffic came in over the last 30 days.
 */
export async function getHostelViewStats(hostelIds: Types.ObjectId[]) {
  if (hostelIds.length === 0) {
    return { publicViewsLast30Days: 0, totalPublicViews: 0, uniquePublicVisitors: 0 };
  }

  await connectToDatabase();

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const [hostels, uniqueVisitors, recentViews] = await Promise.all([
    HostelModel.find({ _id: { $in: hostelIds } })
      .select("publicViewCount")
      .lean<{ publicViewCount?: number }[]>(),
    // Counted in Mongo: distinct() returned every key and hits the 16 MB cap (Go P11-12).
    HostelPageViewModel.aggregate<{ n: number }>([
      { $match: { hostelId: { $in: hostelIds }, visitorKey: { $exists: true } } },
      { $group: { _id: "$visitorKey" } },
      { $count: "n" },
    ]),
    HostelPageViewModel.countDocuments({
      createdAt: { $gte: thirtyDaysAgo },
      hostelId: { $in: hostelIds },
    }),
  ]);

  return {
    publicViewsLast30Days: recentViews,
    totalPublicViews: hostels.reduce(
      (total, hostel) => total + (hostel.publicViewCount ?? 0),
      0,
    ),
    uniquePublicVisitors: uniqueVisitors[0]?.n ?? 0,
  };
}
