import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { HostelModel } from "@hostel/db/models/Hostel";
import { QuestionCallClickModel } from "@hostel/db/models/QuestionCallClick";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";
import { findCurrentResident } from "@/modules/residents/resident-access";
import type {
  questionCallAnalyticsQuerySchema,
  questionCallClickSchema,
  questionCallConversionSchema,
} from "@/modules/questioncall/questioncall.validation";

type QuestionCallClickInput = z.infer<typeof questionCallClickSchema>;
type QuestionCallAnalyticsQuery = z.infer<typeof questionCallAnalyticsQuerySchema>;
type QuestionCallConversionInput = z.infer<typeof questionCallConversionSchema>;

export class QuestionCallServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "QUESTIONCALL_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

type ClickRecord = {
  _id: Types.ObjectId;
  clickedAt: Date;
  converted?: boolean;
  conversionTrackedAt?: Date;
  deviceType?: string;
  hostelId: Types.ObjectId;
  userId: Types.ObjectId;
};

/**
 * Records the click. Where the resident goes is the `questionCall` site-config
 * link, which both clients open straight from the tap — a window opened after a
 * round trip is a popup the browser blocks. `redirectUrl` is that same link,
 * kept for app builds older than the 2026-10-01 row, which open what this
 * returns.
 *
 * Only STUDENT residents see the entry point (PHASES.md §5.1), and the check is
 * repeated here — a hidden button is not access control.
 */
export async function trackQuestionCallClick(
  input: QuestionCallClickInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);

  if ((resident.residentType ?? "STUDENT") !== "STUDENT") {
    throw new QuestionCallServiceError(
      "QuestionCall is available to student residents only.",
      "QUESTIONCALL_NOT_ELIGIBLE",
      403,
    );
  }

  const click = await QuestionCallClickModel.create({
    clickedAt: new Date(),
    converted: false,
    deviceType: input.deviceType,
    hostelId: resident.hostelId,
    residentId: resident._id,
    userId: resident.userId ?? principal.userId,
  });

  const { url } = await getSiteConfigSection("questionCall");

  return { clickId: click._id.toString(), redirectUrl: url };
}

export async function getQuestionCallStatus(principal: ApiPrincipal) {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);
  const [latest, clickCount] = await Promise.all([
    QuestionCallClickModel.findOne({ residentId: resident._id })
      .sort({ clickedAt: -1 })
      .lean<ClickRecord | null>(),
    QuestionCallClickModel.countDocuments({ residentId: resident._id }),
  ]);

  return {
    clickCount,
    converted: Boolean(latest?.converted),
    eligible: (resident.residentType ?? "STUDENT") === "STUDENT",
    lastClickedAt: latest?.clickedAt?.toISOString(),
  };
}

/**
 * Callback from QuestionCall confirming a referred student signed up there.
 * Idempotent: a repeated ping does not move `conversionTrackedAt`.
 */
export async function recordQuestionCallConversion(input: QuestionCallConversionInput) {
  await connectToDatabase();

  if (!input.clickId && !input.userId) {
    throw new QuestionCallServiceError(
      "A clickId or userId is required.",
      "QUESTIONCALL_CONVERSION_TARGET_REQUIRED",
      422,
    );
  }

  const filter = input.clickId
    ? { _id: new Types.ObjectId(input.clickId) }
    : { userId: new Types.ObjectId(input.userId) };

  const result = await QuestionCallClickModel.updateMany(
    { ...filter, converted: { $ne: true } },
    { $set: { conversionTrackedAt: new Date(), converted: true } },
  );

  return { updated: result.modifiedCount ?? 0 };
}

function dayKey(value: Date) {
  return value.toISOString().slice(0, 10);
}

export async function getQuestionCallAnalytics(query: QuestionCallAnalyticsQuery) {
  await connectToDatabase();

  const filter: Record<string, unknown> = {};

  if (query.hostelId) {
    filter.hostelId = new Types.ObjectId(query.hostelId);
  }

  if (query.startDate || query.endDate) {
    filter.clickedAt = {
      ...(query.startDate ? { $gte: query.startDate } : {}),
      ...(query.endDate ? { $lte: query.endDate } : {}),
    };
  }

  const clicks = await QuestionCallClickModel.find(filter)
    .sort({ clickedAt: -1 })
    .limit(5000)
    .lean<ClickRecord[]>();

  const perHostel = new Map<string, { clicks: number; conversions: number }>();
  const perDay = new Map<string, { clicks: number; conversions: number }>();
  const uniqueUsers = new Set<string>();
  let conversions = 0;

  for (const click of clicks) {
    const hostelKey = click.hostelId.toString();
    const hostelEntry = perHostel.get(hostelKey) ?? { clicks: 0, conversions: 0 };
    const day = dayKey(click.clickedAt);
    const dayEntry = perDay.get(day) ?? { clicks: 0, conversions: 0 };

    hostelEntry.clicks += 1;
    dayEntry.clicks += 1;
    uniqueUsers.add(click.userId.toString());

    if (click.converted) {
      conversions += 1;
      hostelEntry.conversions += 1;
      dayEntry.conversions += 1;
    }

    perHostel.set(hostelKey, hostelEntry);
    perDay.set(day, dayEntry);
  }

  // Names, not ObjectIds — the breakdown is read by a person.
  const hostels = await HostelModel.find({
    _id: { $in: [...perHostel.keys()].map((id) => new Types.ObjectId(id)) },
  })
    .select("name")
    .lean<Array<{ _id: Types.ObjectId; name: string }>>();
  const hostelNameById = new Map(
    hostels.map((hostel) => [hostel._id.toString(), hostel.name]),
  );

  const byHostel = [...perHostel.entries()]
    .map(([hostelId, entry]) => ({
      clicks: entry.clicks,
      conversionRate: entry.clicks > 0 ? entry.conversions / entry.clicks : 0,
      conversions: entry.conversions,
      hostelId,
      hostelName: hostelNameById.get(hostelId) ?? "Unknown hostel",
    }))
    .sort((a, b) => b.clicks - a.clicks);

  return {
    byDay: [...perDay.entries()]
      .map(([date, entry]) => ({ ...entry, date }))
      .sort((a, b) => a.date.localeCompare(b.date)),
    byHostel,
    summary: {
      conversionRate: clicks.length > 0 ? conversions / clicks.length : 0,
      conversions,
      totalClicks: clicks.length,
      uniqueResidents: uniqueUsers.size,
    },
  };
}
