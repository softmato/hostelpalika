import crypto from "node:crypto";

import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { HostelModel } from "@hostel/db/models/Hostel";
import { QuestionCallClickModel } from "@hostel/db/models/QuestionCallClick";
import { UserModel } from "@hostel/db/models/User";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";
import { findCurrentResident } from "@/modules/residents/resident-access";
import type {
  questionCallAnalyticsQuerySchema,
  questionCallClickSchema,
  questionCallConversionSchema,
  questionCallSsoExchangeSchema,
} from "@/modules/questioncall/questioncall.validation";

type QuestionCallClickInput = z.infer<typeof questionCallClickSchema>;
type QuestionCallAnalyticsQuery = z.infer<typeof questionCallAnalyticsQuerySchema>;
type QuestionCallConversionInput = z.infer<typeof questionCallConversionSchema>;
type QuestionCallSsoExchangeInput = z.infer<typeof questionCallSsoExchangeSchema>;

/** Long enough for QuestionCall's app to cold-start, short enough to be useless in a log. */
const SSO_CODE_TTL_MS = 5 * 60 * 1000;

function hashSsoSecret(secret: string) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

type SsoUser = {
  _id: Types.ObjectId;
  email?: string;
  emailVerified?: boolean;
  emailVerifiedAt?: Date | null;
  name: string;
  phone?: string;
  status?: string;
};

/**
 * Only a verified email is vouched for: QuestionCall keys accounts on email, so
 * an unverified one would hand its owner's QuestionCall account to whoever typed
 * it in here.
 */
function canSignInToQuestionCall(user: SsoUser | null): user is SsoUser & { email: string } {
  return Boolean(
    user?.email && (user.emailVerified || user.emailVerifiedAt) && (user.status ?? "ACTIVE") === "ACTIVE",
  );
}

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
 * Records the click and, for a verified email, mints the single-use `ssoCode`
 * QuestionCall trades (server to server) for this resident's identity — so they
 * land signed in, the way ChatGPT opens inside Viber. `ssoCode` is null when
 * there is nothing to vouch for; QuestionCall then shows its own sign-in.
 *
 * `redirectUrl` is the `questionCall` site-config link, kept for app builds older
 * than the 2026-10-01 row, which open what this returns.
 *
 * Every resident sees the entry point, students or not.
 */
export async function trackQuestionCallClick(
  input: QuestionCallClickInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const resident = await findCurrentResident(principal);

  const userId = resident.userId ?? principal.userId;
  const user = await UserModel.findById(userId)
    .select("email emailVerified emailVerifiedAt name status")
    .lean<SsoUser | null>();
  const clickId = new Types.ObjectId();
  const ssoSecret = canSignInToQuestionCall(user)
    ? crypto.randomBytes(32).toString("base64url")
    : null;

  await QuestionCallClickModel.create({
    _id: clickId,
    clickedAt: new Date(),
    converted: false,
    deviceType: input.deviceType,
    hostelId: resident.hostelId,
    residentId: resident._id,
    ...(ssoSecret
      ? {
          ssoCodeHash: hashSsoSecret(ssoSecret),
          ssoExpiresAt: new Date(Date.now() + SSO_CODE_TTL_MS),
        }
      : {}),
    userId,
  });

  const { url } = await getSiteConfigSection("questionCall");

  return {
    clickId: clickId.toString(),
    redirectUrl: url,
    ssoCode: ssoSecret ? `${clickId.toString()}.${ssoSecret}` : null,
  };
}

/**
 * QuestionCall's backend trading an `ssoCode` for who the resident is. Burns
 * the code in the same write that finds it, so a replay — or a second tab —
 * gets nothing. The account is re-checked here, not trusted from the tap.
 */
export async function exchangeQuestionCallSsoCode(input: QuestionCallSsoExchangeInput) {
  await connectToDatabase();

  const [clickId, secret] = input.code.split(".");
  const invalid = new QuestionCallServiceError(
    "This sign-in link has expired or was already used.",
    "QUESTIONCALL_SSO_INVALID",
    401,
  );

  if (!clickId || !secret || !Types.ObjectId.isValid(clickId)) {
    throw invalid;
  }

  const click = await QuestionCallClickModel.findOneAndUpdate(
    {
      _id: new Types.ObjectId(clickId),
      ssoCodeHash: hashSsoSecret(secret),
      ssoExpiresAt: { $gt: new Date() },
      ssoUsedAt: null,
    },
    { $set: { ssoUsedAt: new Date() } },
  ).lean<ClickRecord | null>();

  if (!click) {
    throw invalid;
  }

  const user = await UserModel.findById(click.userId)
    .select("email emailVerified emailVerifiedAt name phone status")
    .lean<SsoUser | null>();

  if (!canSignInToQuestionCall(user)) {
    throw invalid;
  }

  return {
    clickId: click._id.toString(),
    user: {
      email: user.email,
      id: user._id.toString(),
      name: user.name,
      phone: user.phone ?? null,
    },
  };
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
    eligible: true,
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

  // Counted in Mongo, every click: reading the newest 5,000 and summing those
  // undercounted any busy range without saying so.
  const counts = {
    clicks: { $sum: 1 },
    conversions: { $sum: { $cond: [{ $eq: ["$converted", true] }, 1, 0] } },
  };
  type Count = { _id: unknown; clicks: number; conversions: number };
  const [facets] = await QuestionCallClickModel.aggregate<{
    days: Array<Count & { _id: string }>;
    hostels: Array<Count & { _id: Types.ObjectId }>;
    total: Count[];
    users: Array<{ n: number }>;
  }>([
    { $match: filter },
    {
      $facet: {
        // Ties keep the old order: the hostel clicked most recently first.
        hostels: [
          { $group: { _id: "$hostelId", ...counts, last: { $max: "$clickedAt" } } },
          { $sort: { clicks: -1, last: -1 } },
        ],
        days: [
          { $group: { _id: { $dateToString: { date: "$clickedAt", format: "%Y-%m-%d" } }, ...counts } },
          { $sort: { _id: 1 } },
        ],
        total: [{ $group: { _id: null, ...counts } }],
        users: [{ $group: { _id: "$userId" } }, { $count: "n" }],
      },
    },
  ]);

  // Names, not ObjectIds — the breakdown is read by a person.
  const hostels = await HostelModel.find({ _id: { $in: facets.hostels.map((row) => row._id) } })
    .select("name")
    .lean<Array<{ _id: Types.ObjectId; name: string }>>();
  const hostelNameById = new Map(hostels.map((hostel) => [hostel._id.toString(), hostel.name]));
  const rate = (conversions: number, clicks: number) => (clicks > 0 ? conversions / clicks : 0);
  const total = facets.total[0] ?? { clicks: 0, conversions: 0 };

  return {
    byDay: facets.days.map((row) => ({ clicks: row.clicks, conversions: row.conversions, date: row._id })),
    byHostel: facets.hostels.map((row) => ({
      clicks: row.clicks,
      conversionRate: rate(row.conversions, row.clicks),
      conversions: row.conversions,
      hostelId: row._id.toString(),
      hostelName: hostelNameById.get(row._id.toString()) ?? "Unknown hostel",
    })),
    summary: {
      conversionRate: rate(total.conversions, total.clicks),
      conversions: total.conversions,
      totalClicks: total.clicks,
      uniqueResidents: facets.users[0]?.n ?? 0,
    },
  };
}
