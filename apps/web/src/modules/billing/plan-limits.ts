import type { Types } from "mongoose";

import { Role } from "@/lib/roles";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { PLAN_DUE_NOTIFICATION_TYPE } from "@/modules/notifications/push-routing";
import { billingHostelId } from "@/modules/billing/billing-hostel";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";
import { resolveHostelAdminContacts } from "@/modules/residents/resident-notify";
import { CookAccountModel } from "@hostel/db/models/CookAccount";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelMemberModel } from "@hostel/db/models/HostelMember";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { ResidentModel } from "@hostel/db/models/Resident";
import { hostelDayEnd } from "@hostel/shared/calendar/bs";
import { getPlan, type PlansCatalog, type PlanTierLike } from "@hostel/shared/plans/catalog";

/**
 * The plan's ceilings — residents, wardens, cooks — held on the server.
 *
 * Read from the live catalogue by the subscription's `planId`: limits are not
 * snapshotted at purchase, so a superadmin raising Pro's cap raises it for every
 * Pro hostel at once. No plan chosen, or a plan the catalogue no longer has, is
 * no ceiling — a hostel is never locked out by a missing row.
 */
export type PlanSeat = "residents" | "wardens" | "cooks";

const NOUN: Record<PlanSeat, string> = { cooks: "cooks", residents: "residents", wardens: "wardens" };

export class PlanLimitError extends Error {
  errorCode = "PLAN_LIMIT_REACHED";
  status = 409;
}

function countLive(hostelId: Types.ObjectId, seat: PlanSeat) {
  if (seat === "residents") {
    return ResidentModel.countDocuments({ hostelId, isDeleted: false, status: { $ne: "MOVED_OUT" } });
  }

  if (seat === "wardens") {
    return HostelMemberModel.countDocuments({
      hostelId,
      isDeleted: { $ne: true },
      role: Role.WARDEN,
      status: "ACTIVE",
    });
  }

  return CookAccountModel.countDocuments({ hostelId, status: { $in: ["ACTIVE", "INVITED"] } });
}

type CapsPlan = Pick<PlanTierLike, "maxResidents" | "name" | "portalAccess">;

export type PlanSub = {
  currentPeriodEnd?: Date | null;
  lifetimeSince?: Date | null;
  planId?: string | null;
  trialEndsAt?: Date | null;
};

const SUB_FIELDS = "planId trialEndsAt currentPeriodEnd lifetimeSince";

/**
 * Where a hostel stands. One rule: a live paid plan holds its own caps, a
 * running trial has none, and every other hostel — trial over unpaid, paid
 * period lapsed, a plan chosen but never paid — is on the free tier. Hostels
 * from before trials with no plan (`none`) stay uncapped. **Pure.**
 */
export function planState(
  catalog: PlansCatalog,
  sub: PlanSub | null,
  now = new Date(),
): { kind: "none" | "trial" | "paid" | "free"; plan: CapsPlan | null } {
  if (!sub) return { kind: "none", plan: null };

  const paidLive =
    Boolean(sub.planId) &&
    (Boolean(sub.lifetimeSince) || Boolean(sub.currentPeriodEnd && sub.currentPeriodEnd.getTime() > now.getTime()));

  if (paidLive) return { kind: "paid", plan: getPlan(catalog, sub.planId!) ?? null };
  if (sub.trialEndsAt && sub.trialEndsAt.getTime() > now.getTime()) return { kind: "trial", plan: null };
  if (!sub.planId && !sub.trialEndsAt) return { kind: "none", plan: null };

  return { kind: "free", plan: catalog.free ?? null };
}

/** The plan whose caps hold right now, or none. **Pure.** */
export function planForCaps(catalog: PlansCatalog, sub: PlanSub | null, now = new Date()) {
  return planState(catalog, sub, now).plan;
}

export type PlanUsage = Record<PlanSeat, number>;

function capOf(plan: CapsPlan, seat: PlanSeat) {
  return seat === "residents" ? plan.maxResidents : plan.portalAccess[seat];
}

/** Seats past their cap. **Pure.** */
export function seatsOver(plan: CapsPlan, used: PlanUsage) {
  return (["residents", "wardens", "cooks"] as const).filter((seat) => {
    const cap = capOf(plan, seat);
    return cap !== null && cap !== undefined && used[seat] > cap;
  });
}

async function countUsage(hostelId: Types.ObjectId): Promise<PlanUsage> {
  const [residents, wardens, cooks] = await Promise.all([
    countLive(hostelId, "residents"),
    countLive(hostelId, "wardens"),
    countLive(hostelId, "cooks"),
  ]);

  return { cooks, residents, wardens };
}

type PlanLimitRecord = { overSince: Date; readOnlyFrom: Date };

/**
 * Brings `Hostel.planLimit` up to date: stamped the first time a free-tier
 * hostel is seen over its caps (read-only after the grace days), cleared the
 * moment it is back within them or on a paid plan.
 */
export async function refreshPlanLimit(hostelId: Types.ObjectId, now = new Date()) {
  const [sub, catalog, used, hostel] = await Promise.all([
    billingHostelId(hostelId).then((id) =>
      HostelSubscriptionModel.findOne({ hostelId: id }).select(SUB_FIELDS).lean<PlanSub | null>(),
    ),
    getSiteConfigSection("plans"),
    countUsage(hostelId),
    HostelModel.findById(hostelId).select("planLimit").lean<{ planLimit?: PlanLimitRecord | null } | null>(),
  ]);
  const state = planState(catalog, sub, now);
  const over = state.kind === "free" && state.plan !== null && seatsOver(state.plan, used).length > 0;
  let planLimit: PlanLimitRecord | null = hostel?.planLimit?.overSince ? hostel.planLimit : null;

  if (over && !planLimit) {
    planLimit = { overSince: now, readOnlyFrom: hostelDayEnd(now, catalog.free?.overLimitGraceDays ?? 7) };
    await HostelModel.updateOne({ _id: hostelId }, { $set: { planLimit } });
  } else if (!over && planLimit) {
    planLimit = null;
    await HostelModel.updateOne({ _id: hostelId }, { $unset: { planLimit: 1 } });
  }

  return { planLimit, state, sub, used };
}

/** `GET /hostel-admin/billing/usage`: the plan, its caps, what is used, and any over-limit clock. */
export async function getPlanUsage(hostelId: Types.ObjectId, now = new Date()) {
  const { planLimit, state, sub, used } = await refreshPlanLimit(hostelId, now);
  const cap = (seat: PlanSeat) => (state.plan ? (capOf(state.plan, seat) ?? null) : null);

  return {
    state: state.kind,
    planName: state.plan?.name ?? null,
    caps: { residents: cap("residents"), wardens: cap("wardens"), cooks: cap("cooks") },
    used: { residents: used.residents, wardens: used.wardens, cooks: used.cooks },
    overLimit: planLimit !== null,
    overSince: planLimit?.overSince.toISOString() ?? null,
    readOnlyFrom: planLimit?.readOnlyFrom.toISOString() ?? null,
    readOnly: planLimit !== null && planLimit.readOnlyFrom.getTime() <= now.getTime(),
    trialEndsAt: sub?.trialEndsAt?.toISOString() ?? null,
  };
}

/** Throws `PLAN_LIMIT_REACHED` (and tells the admins) when `adding` more would pass the plan's cap. */
export async function assertPlanRoom(hostelId: Types.ObjectId, seat: PlanSeat, adding = 1) {
  // A branch is on its main hostel's plan; its own seats are counted against it.
  const subscription = await HostelSubscriptionModel.findOne({ hostelId: await billingHostelId(hostelId) })
    .select(SUB_FIELDS)
    .lean<PlanSub | null>();

  const plan = planForCaps(await getSiteConfigSection("plans"), subscription);
  const cap = plan ? capOf(plan, seat) : null;

  if (cap === null || cap === undefined) return;
  if ((await countLive(hostelId, seat)) + adding <= cap) return;

  const message = `Your ${plan!.name} plan allows ${cap} ${NOUN[seat]} and you have reached that limit. Please upgrade your plan to add more.`;

  await notifyLimitReached(hostelId, message).catch(() => undefined);

  throw new PlanLimitError(message);
}

/** Bell + push to every admin; `PLAN_DUE` routing opens Billing on web and in the app. */
async function notifyLimitReached(hostelId: Types.ObjectId, body: string) {
  const [contacts, hostel] = await Promise.all([
    resolveHostelAdminContacts(hostelId),
    HostelModel.findById(hostelId).select("slug").lean<{ slug?: string } | null>(),
  ]);

  await Promise.all(
    contacts
      .filter((contact) => contact.userId)
      .map((contact) =>
        createInAppNotification({
          body,
          category: "PAYMENT",
          data: { hostelSlug: hostel?.slug ?? "", reason: "PLAN_LIMIT", type: PLAN_DUE_NOTIFICATION_TYPE },
          hostelId: hostelId.toString(),
          priority: "HIGH",
          title: "Plan limit reached",
          userId: contact.userId!,
        }).catch(() => undefined),
      ),
  );
}
