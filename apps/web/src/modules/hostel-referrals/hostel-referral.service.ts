import { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import {
  commissionFor,
  describeBonus,
  extendByBonus,
  hasBonus,
  hostelCodeCandidates,
  normalizeHostelReferralCode,
  type PlanBonus,
} from "@/modules/hostel-referrals/hostel-referral.rules";
import {
  hostelReferralSettingsSchema,
  type HostelReferralSettings,
  type hostelReferralInviteSchema,
  type partnerCodeCreateSchema,
  type partnerCodeUpdateSchema,
} from "@/modules/hostel-referrals/hostel-referral.validation";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { appUrl, sendNotificationEmail } from "@/modules/residents/resident-notify";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelReferralModel } from "@hostel/db/models/HostelReferral";
import { HostelReferralCodeModel } from "@hostel/db/models/HostelReferralCode";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { PlatformSettingModel } from "@hostel/db/models/PlatformSetting";
import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import { hostelReferralInviteEmail } from "@hostel/shared/email/templates/hostel/hostel-referral-invite";

/**
 * Hostel referrals: a hostel (or a superadmin's marketing partner) hands a new
 * hostel a code; when that hostel goes live both sides get extra plan time and
 * a partner earns a commission.
 *
 * - Codes: `HostelReferralCode`, one per hostel plus any partner codes.
 * - Uses: `HostelReferral`, one per registered hostel, rewards snapshotted.
 * - Settings: the `hostel-referrals` PlatformSetting (hostel-to-hostel rewards).
 *
 * Nothing is given at registration. The reward lands at go-live
 * (`settleHostelReferrals`, called from `openHostelAfterPayment`), because a
 * registration can still be rejected.
 */

export class HostelReferralError extends Error {
  constructor(
    message: string,
    public errorCode = "HOSTEL_REFERRAL_ERROR",
    public status = 422,
  ) {
    super(message);
  }
}

const SETTINGS_KEY = "hostel-referrals";
/** Invite emails one hostel may send in a day. */
const DAILY_INVITES = 20;

type CodeRecord = {
  _id: Types.ObjectId;
  code: string;
  commissionType: "AMOUNT" | "PERCENT";
  commissionValue: number;
  contact?: string;
  createdAt: Date;
  hostelId?: Types.ObjectId | null;
  kind: "HOSTEL" | "PARTNER";
  name?: string;
  note?: string;
  offerDays: number;
  offerMonths: number;
  status: "ACTIVE" | "INACTIVE";
};

type ReferralRecord = {
  _id: Types.ObjectId;
  code: string;
  codeId: Types.ObjectId;
  commission: {
    amount: number;
    paidAt?: Date | null;
    status: "NONE" | "EARNED" | "PAID";
    type: "AMOUNT" | "PERCENT";
    value: number;
  };
  createdAt: Date;
  kind: "HOSTEL" | "PARTNER";
  liveAt?: Date | null;
  refereeAppliedAt?: Date | null;
  refereeHostelId: Types.ObjectId;
  refereeReward: PlanBonus;
  referrerAppliedAt?: Date | null;
  referrerHostelId?: Types.ObjectId | null;
  referrerReward: PlanBonus;
  status: "PENDING" | "LIVE";
};

function objectId(value: string, label = "record") {
  if (!Types.ObjectId.isValid(value)) {
    throw new HostelReferralError(`That ${label} was not found.`, "NOT_FOUND", 404);
  }

  return new Types.ObjectId(value);
}

function registerLink(code: string) {
  return appUrl(`/register-hostel?ref=${encodeURIComponent(code)}`);
}

/* -------------------------------------------------------------------------- */
/* Settings                                                                   */
/* -------------------------------------------------------------------------- */

/** Never throws: a bad or missing row falls back to the shipped defaults. */
export async function getHostelReferralSettings(): Promise<HostelReferralSettings> {
  try {
    await connectToDatabase();

    const record = await PlatformSettingModel.findOne({ key: SETTINGS_KEY })
      .lean<{ value?: unknown } | null>();
    const parsed = hostelReferralSettingsSchema.safeParse(record?.value ?? {});

    return parsed.success ? parsed.data : hostelReferralSettingsSchema.parse({});
  } catch {
    return hostelReferralSettingsSchema.parse({});
  }
}

export async function saveHostelReferralSettings(input: unknown, actorId: string) {
  await connectToDatabase();

  const current = await getHostelReferralSettings();
  const next = hostelReferralSettingsSchema.parse({
    ...current,
    ...(typeof input === "object" && input !== null ? input : {}),
  });

  await PlatformSettingModel.findOneAndUpdate(
    { key: SETTINGS_KEY },
    { $set: { key: SETTINGS_KEY, updatedBy: actorId, value: next } },
    { upsert: true },
  );

  return next;
}

/* -------------------------------------------------------------------------- */
/* Codes                                                                      */
/* -------------------------------------------------------------------------- */

/** The hostel's own code, made the first time anyone asks for it. */
export async function getOrCreateHostelCode(hostelId: string) {
  await connectToDatabase();

  const id = objectId(hostelId, "hostel");
  const existing = await HostelReferralCodeModel.findOne({ hostelId: id, kind: "HOSTEL" })
    .select("code")
    .lean<{ code: string } | null>();

  if (existing) {
    return existing.code;
  }

  const hostel = await HostelModel.findById(id).select("name").lean<{ name?: string } | null>();

  if (!hostel) {
    throw new HostelReferralError("That hostel was not found.", "NOT_FOUND", 404);
  }

  for (const code of hostelCodeCandidates(hostel.name ?? "", id.toString())) {
    try {
      await HostelReferralCodeModel.create({ code, hostelId: id, kind: "HOSTEL" });

      return code;
    } catch (error) {
      if ((error as { code?: number }).code !== 11000) {
        throw error;
      }

      // Either the code is taken (try a longer one) or a parallel request just
      // made this hostel's code (read it back).
      const raced = await HostelReferralCodeModel.findOne({ hostelId: id, kind: "HOSTEL" })
        .select("code")
        .lean<{ code: string } | null>();

      if (raced) {
        return raced.code;
      }
    }
  }

  throw new HostelReferralError("Could not make a referral code. Try again.");
}

export type ResolvedReferralCode = {
  code: string;
  codeId: Types.ObjectId;
  commission: { type: "AMOUNT" | "PERCENT"; value: number };
  from: string;
  kind: "HOSTEL" | "PARTNER";
  refereeReward: PlanBonus;
  referrerHostelId: Types.ObjectId | null;
  referrerOwnerId: Types.ObjectId | null;
  referrerReward: PlanBonus;
};

/** A live code and what it gives, or a 422 the registration form can show. */
export async function resolveHostelReferralCode(raw: string): Promise<ResolvedReferralCode> {
  await connectToDatabase();

  const code = normalizeHostelReferralCode(raw);
  const invalid = new HostelReferralError(
    "That referral code is not valid. Check it, or carry on with a normal registration.",
    "REFERRAL_CODE_INVALID",
  );

  if (code.length < 4) {
    throw invalid;
  }

  const record = await HostelReferralCodeModel.findOne({ code, status: "ACTIVE" }).lean<CodeRecord | null>();

  if (!record) {
    throw invalid;
  }

  if (record.kind === "PARTNER") {
    return {
      code: record.code,
      codeId: record._id,
      commission: { type: record.commissionType, value: record.commissionValue },
      from: record.name ?? "",
      kind: "PARTNER",
      refereeReward: { days: record.offerDays, months: record.offerMonths },
      referrerHostelId: null,
      referrerOwnerId: null,
      referrerReward: { days: 0, months: 0 },
    };
  }

  const [settings, hostel] = await Promise.all([
    getHostelReferralSettings(),
    HostelModel.findOne({ _id: record.hostelId, isDeleted: { $ne: true } })
      .select("name ownerId")
      .lean<{ _id: Types.ObjectId; name?: string; ownerId?: Types.ObjectId } | null>(),
  ]);

  if (!hostel) {
    throw invalid;
  }

  if (!settings.enabled) {
    throw new HostelReferralError(
      "Hostel referral codes are paused right now. Carry on with a normal registration.",
      "REFERRAL_PAUSED",
    );
  }

  return {
    code: record.code,
    codeId: record._id,
    commission: { type: "AMOUNT", value: 0 },
    from: hostel.name ?? "",
    kind: "HOSTEL",
    refereeReward: settings.referee,
    referrerHostelId: hostel._id,
    referrerOwnerId: hostel.ownerId ?? null,
    referrerReward: settings.referrer,
  };
}

/** What the registration form shows once a code checks out. */
export async function previewHostelReferralCode(raw: string) {
  const resolved = await resolveHostelReferralCode(raw);

  return {
    code: resolved.code,
    from: resolved.from,
    kind: resolved.kind,
    reward: resolved.refereeReward,
    rewardText: describeBonus(resolved.refereeReward),
  };
}

/** Called by the public registration, after the hostel exists. */
export async function recordHostelReferral(
  resolved: ResolvedReferralCode,
  refereeHostelId: Types.ObjectId,
) {
  await HostelReferralModel.create({
    code: resolved.code,
    codeId: resolved.codeId,
    commission: { ...resolved.commission, amount: 0, status: "NONE" },
    kind: resolved.kind,
    refereeHostelId,
    refereeReward: resolved.refereeReward,
    referrerHostelId: resolved.referrerHostelId,
    referrerReward: resolved.referrerReward,
  });
}

/* -------------------------------------------------------------------------- */
/* Go-live                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Adds extra time to a running plan. `false` when it cannot yet: no running
 * period, or a plan bill is open.
 *
 * ponytail: an open bill defers the bonus until it is paid, because its
 * printed service period is fixed at issue and `startPlanPeriod` would treat a
 * period already past it as paid. Shift open invoices' periods if owners mind
 * paying before the bonus lands.
 */
async function addPlanBonus(hostelId: Types.ObjectId, bonus: PlanBonus, reason: string) {
  const subscription = await HostelSubscriptionModel.findOne({ hostelId })
    .select("_id currentPeriodEnd freeUntil lifetimeSince status")
    .lean<{
      _id: Types.ObjectId;
      currentPeriodEnd?: Date | null;
      freeUntil?: Date | null;
      lifetimeSince?: Date | null;
      status?: string;
    } | null>();

  if (!subscription?.currentPeriodEnd || subscription.status !== "ACTIVE") {
    return false;
  }

  // A lifetime plan has no end to push back, and its period end is past the
  // Bikram Sambat range `extendByBonus` counts in.
  if (subscription.lifetimeSince) {
    return false;
  }

  const openBill = await SubscriptionInvoiceModel.exists({
    kind: { $ne: "SETUP_FEE" },
    status: { $in: ["OPEN", "PARTIAL"] },
    subscriptionId: subscription._id,
  });

  if (openBill) {
    return false;
  }

  const end = extendByBonus(subscription.currentPeriodEnd, bonus);
  // Keeps the first bill after free months at the price agreed at sign-up
  // (`raiseDueRenewals` compares the two).
  const stillFree =
    subscription.freeUntil?.getTime() === subscription.currentPeriodEnd.getTime();

  const result = await HostelSubscriptionModel.updateOne(
    { _id: subscription._id, currentPeriodEnd: subscription.currentPeriodEnd },
    { $set: { currentPeriodEnd: end, ...(stillFree ? { freeUntil: end } : {}) } },
  );

  if (result.modifiedCount === 0) {
    return false;
  }

  await AuditLogModel.create({
    action: "SUBSCRIPTION_REFERRAL_BONUS_ADDED",
    actorType: "SYSTEM",
    entityId: subscription._id.toString(),
    entityType: "HostelSubscription",
    hostelId,
    metadata: { ...bonus, from: subscription.currentPeriodEnd.toISOString(), reason, to: end.toISOString() },
  });

  return true;
}

/** Claims a side, adds its time, and hands the claim back if the time could not go on yet. */
async function applySide(row: ReferralRecord, side: "referee" | "referrer") {
  const field = side === "referee" ? "refereeAppliedAt" : "referrerAppliedAt";
  const hostelId = side === "referee" ? row.refereeHostelId : row.referrerHostelId;
  const reward = side === "referee" ? row.refereeReward : row.referrerReward;

  if (!hostelId) {
    return;
  }

  const claim = await HostelReferralModel.updateOne(
    { _id: row._id, [field]: null },
    { $set: { [field]: new Date() } },
  );

  if (claim.modifiedCount === 0 || !hasBonus(reward)) {
    return;
  }

  if (!(await addPlanBonus(hostelId, reward, `referral:${row.code}:${side}`))) {
    await HostelReferralModel.updateOne({ _id: row._id }, { $set: { [field]: null } });
  }
}

/**
 * Runs each time a hostel goes live or pays its plan in full. Marks its own
 * referral live (commission, the referrer's bell) and adds any extra time
 * still owed to it on either side. Idempotent; never throws past its caller's
 * try.
 */
export async function settleHostelReferrals(hostelId: Types.ObjectId | string) {
  await connectToDatabase();

  const id = new Types.ObjectId(String(hostelId));
  const justLive = await HostelReferralModel.findOneAndUpdate(
    { refereeHostelId: id, status: "PENDING" },
    { $set: { liveAt: new Date(), status: "LIVE" } },
    { new: true },
  ).lean<ReferralRecord | null>();

  if (justLive) {
    await onReferralLive(justLive);
  }

  const owed = await HostelReferralModel.find({
    $or: [
      { refereeAppliedAt: null, refereeHostelId: id },
      { referrerAppliedAt: null, referrerHostelId: id },
      ...(justLive ? [{ _id: justLive._id }] : []),
    ],
    status: "LIVE",
  }).lean<ReferralRecord[]>();

  for (const row of owed) {
    if (!row.refereeAppliedAt) {
      await applySide(row, "referee");
    }

    if (row.referrerHostelId && !row.referrerAppliedAt) {
      await applySide(row, "referrer");
    }
  }
}

async function onReferralLive(row: ReferralRecord) {
  if (row.kind === "PARTNER" && row.commission.value > 0) {
    const subscription = await HostelSubscriptionModel.findOne({ hostelId: row.refereeHostelId })
      .select("cycleTotal")
      .lean<{ cycleTotal?: number | null } | null>();
    const amount = commissionFor(row.commission, subscription?.cycleTotal);

    if (amount > 0) {
      await HostelReferralModel.updateOne(
        { _id: row._id },
        { $set: { "commission.amount": amount, "commission.status": "EARNED" } },
      );
    }
  }

  if (!row.referrerHostelId) {
    return;
  }

  const [referee, referrer] = await Promise.all([
    HostelModel.findById(row.refereeHostelId).select("name").lean<{ name?: string } | null>(),
    HostelModel.findById(row.referrerHostelId).select("ownerId").lean<{ ownerId?: Types.ObjectId } | null>(),
  ]);
  const bonus = describeBonus(row.referrerReward);

  if (referrer?.ownerId) {
    await createInAppNotification({
      body: `${referee?.name ?? "A hostel"} went live with your referral code.${bonus ? ` ${bonus} is added to your plan.` : ""}`,
      category: "billing",
      data: { type: "HOSTEL_REFERRAL_LIVE" },
      hostelId: row.referrerHostelId.toString(),
      title: "A hostel joined with your code",
      userId: referrer.ownerId.toString(),
    }).catch(() => {});
  }
}

/* -------------------------------------------------------------------------- */
/* Hostel side                                                                */
/* -------------------------------------------------------------------------- */

async function hostelNames(ids: Types.ObjectId[]) {
  const hostels = await HostelModel.find({ _id: { $in: ids } })
    .select("name")
    .lean<{ _id: Types.ObjectId; name?: string }[]>();

  return new Map(hostels.map((hostel) => [hostel._id.toString(), hostel.name ?? ""]));
}

/** Invite hostels: the code, the link, what each side gets, and who used it. */
export async function getHostelInviteOverview(hostelId: string) {
  const [code, settings] = await Promise.all([
    getOrCreateHostelCode(hostelId),
    getHostelReferralSettings(),
  ]);

  const rows = await HostelReferralModel.find({ referrerHostelId: objectId(hostelId) })
    .sort({ createdAt: -1 })
    .limit(100)
    .lean<ReferralRecord[]>();
  const names = await hostelNames(rows.map((row) => row.refereeHostelId));

  return {
    code,
    enabled: settings.enabled,
    link: registerLink(code),
    referrals: rows.map((row) => ({
      createdAt: row.createdAt.toISOString(),
      hostelName: names.get(row.refereeHostelId.toString()) || "A hostel",
      id: row._id.toString(),
      liveAt: row.liveAt?.toISOString() ?? null,
      reward: row.referrerReward,
      rewardAdded: Boolean(row.referrerAppliedAt),
      rewardText: describeBonus(row.referrerReward),
      status: row.status,
    })),
    theyGet: { ...settings.referee, text: describeBonus(settings.referee) },
    youGet: { ...settings.referrer, text: describeBonus(settings.referrer) },
  };
}

export async function sendHostelInvite(
  hostelId: string,
  input: z.infer<typeof hostelReferralInviteSchema>,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const id = objectId(hostelId, "hostel");
  const settings = await getHostelReferralSettings();

  if (!settings.enabled) {
    throw new HostelReferralError("Hostel referrals are paused right now.", "REFERRAL_PAUSED");
  }

  const sentToday = await AuditLogModel.countDocuments({
    action: "HOSTEL_REFERRAL_INVITE_SENT",
    createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    hostelId: id,
  });

  if (sentToday >= DAILY_INVITES) {
    throw new HostelReferralError(
      `You can send ${DAILY_INVITES} invites a day. Share the link instead.`,
      "INVITE_LIMIT",
      429,
    );
  }

  const [code, hostel] = await Promise.all([
    getOrCreateHostelCode(hostelId),
    HostelModel.findById(id).select("name").lean<{ name?: string } | null>(),
  ]);
  const email = hostelReferralInviteEmail({
    code,
    fromHostelName: hostel?.name ?? PLATFORM_NAME,
    inviteeName: input.name,
    link: registerLink(code),
    offer: describeBonus(settings.referee),
    platformName: PLATFORM_NAME,
  });

  const sent = await sendNotificationEmail({
    action: "hostel_referral_invite",
    html: email.html,
    subject: email.subject,
    to: input.email,
  });

  if (!sent) {
    throw new HostelReferralError("The invite could not be sent. Try again.", "INVITE_FAILED", 502);
  }

  await AuditLogModel.create({
    action: "HOSTEL_REFERRAL_INVITE_SENT",
    actorId: principal.userId,
    entityId: id.toString(),
    entityType: "Hostel",
    hostelId: id,
    metadata: { email: input.email },
  });

  return { sentTo: input.email };
}

/* -------------------------------------------------------------------------- */
/* Platform side                                                              */
/* -------------------------------------------------------------------------- */

function serializeCode(record: CodeRecord, stats?: { commission: number; live: number; paid: number; registered: number }) {
  return {
    code: record.code,
    commissionType: record.commissionType,
    commissionValue: record.commissionValue,
    contact: record.contact ?? "",
    createdAt: record.createdAt.toISOString(),
    id: record._id.toString(),
    link: registerLink(record.code),
    name: record.name ?? "",
    note: record.note ?? "",
    offerDays: record.offerDays,
    offerMonths: record.offerMonths,
    stats: stats ?? { commission: 0, live: 0, paid: 0, registered: 0 },
    status: record.status,
  };
}

export async function getPlatformReferralOverview() {
  await connectToDatabase();

  const [settings, partnerCodes, stats, rows] = await Promise.all([
    getHostelReferralSettings(),
    HostelReferralCodeModel.find({ kind: "PARTNER" }).sort({ createdAt: -1 }).lean<CodeRecord[]>(),
    HostelReferralModel.aggregate<{
      _id: Types.ObjectId;
      commission: number;
      live: number;
      paid: number;
      registered: number;
    }>([
      {
        $group: {
          _id: "$codeId",
          commission: { $sum: "$commission.amount" },
          live: { $sum: { $cond: [{ $eq: ["$status", "LIVE"] }, 1, 0] } },
          paid: {
            $sum: { $cond: [{ $eq: ["$commission.status", "PAID"] }, "$commission.amount", 0] },
          },
          registered: { $sum: 1 },
        },
      },
    ]),
    // ponytail: newest 200 only; page by createdAt when the list outgrows it.
    HostelReferralModel.find().sort({ createdAt: -1 }).limit(200).lean<ReferralRecord[]>(),
  ]);

  const statsByCode = new Map(stats.map((row) => [row._id.toString(), row]));
  const codeNames = new Map(partnerCodes.map((code) => [code._id.toString(), code.name ?? ""]));
  const names = await hostelNames(
    rows.flatMap((row) => [row.refereeHostelId, ...(row.referrerHostelId ? [row.referrerHostelId] : [])]),
  );

  return {
    partnerCodes: partnerCodes.map((code) => serializeCode(code, statsByCode.get(code._id.toString()))),
    referrals: rows.map((row) => ({
      code: row.code,
      commission: {
        amount: row.commission.amount,
        paidAt: row.commission.paidAt?.toISOString() ?? null,
        status: row.commission.status,
      },
      createdAt: row.createdAt.toISOString(),
      from:
        row.kind === "PARTNER"
          ? codeNames.get(row.codeId.toString()) || "Partner"
          : names.get(row.referrerHostelId?.toString() ?? "") || "A hostel",
      hostelName: names.get(row.refereeHostelId.toString()) || "A hostel",
      id: row._id.toString(),
      kind: row.kind,
      liveAt: row.liveAt?.toISOString() ?? null,
      refereeReward: describeBonus(row.refereeReward),
      referrerReward: describeBonus(row.referrerReward),
      status: row.status,
    })),
    settings,
    totals: {
      commissionOwed: stats.reduce((sum, row) => sum + row.commission - row.paid, 0),
      live: rows.filter((row) => row.status === "LIVE").length,
      registered: stats.reduce((sum, row) => sum + row.registered, 0),
    },
  };
}

async function uniquePartnerCode(name: string) {
  const letters = normalizeHostelReferralCode(name).replace(/[0-9]/g, "").slice(0, 5) || "HP";

  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = `${letters}${Math.floor(1000 + Math.random() * 9000)}`;

    if (!(await HostelReferralCodeModel.exists({ code }))) {
      return code;
    }
  }

  throw new HostelReferralError("Could not make a free code. Type one instead.");
}

export async function createPartnerCode(
  input: z.infer<typeof partnerCodeCreateSchema>,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const code = input.code ? normalizeHostelReferralCode(input.code) : await uniquePartnerCode(input.name);

  if (code.length < 4) {
    throw new HostelReferralError("A code needs at least 4 letters or numbers.");
  }

  if (await HostelReferralCodeModel.exists({ code })) {
    throw new HostelReferralError(`${code} is already in use. Pick another.`, "CODE_TAKEN", 409);
  }

  const record = await HostelReferralCodeModel.create({
    code,
    commissionType: input.commissionType,
    commissionValue: input.commissionValue,
    contact: input.contact ?? "",
    createdBy: principal.userId,
    kind: "PARTNER",
    name: input.name,
    note: input.note ?? "",
    offerDays: input.offerDays,
    offerMonths: input.offerMonths,
  });

  return serializeCode(record.toObject() as CodeRecord);
}

export async function updatePartnerCode(
  codeId: string,
  input: z.infer<typeof partnerCodeUpdateSchema>,
) {
  await connectToDatabase();

  const current = await HostelReferralCodeModel.findOne({ _id: objectId(codeId, "code"), kind: "PARTNER" })
    .lean<CodeRecord | null>();

  if (!current) {
    throw new HostelReferralError("That code was not found.", "NOT_FOUND", 404);
  }

  const commissionType = input.commissionType ?? current.commissionType;
  const commissionValue = input.commissionValue ?? current.commissionValue;

  if (commissionType === "PERCENT" && commissionValue > 100) {
    throw new HostelReferralError("A percent commission is 100 at most.");
  }

  const record = await HostelReferralCodeModel.findByIdAndUpdate(
    current._id,
    { $set: input },
    { new: true },
  ).lean<CodeRecord | null>();

  return serializeCode(record as CodeRecord);
}

export async function markCommissionPaid(referralId: string, principal: ApiPrincipal) {
  await connectToDatabase();

  const result = await HostelReferralModel.updateOne(
    { _id: objectId(referralId, "referral"), "commission.status": "EARNED" },
    { $set: { "commission.paidAt": new Date(), "commission.status": "PAID" } },
  );

  if (result.modifiedCount === 0) {
    throw new HostelReferralError("There is no unpaid commission on that referral.", "NOTHING_OWED", 409);
  }

  await AuditLogModel.create({
    action: "HOSTEL_REFERRAL_COMMISSION_PAID",
    actorId: principal.userId,
    entityId: referralId,
    entityType: "HostelReferral",
  });

  return { id: referralId };
}
