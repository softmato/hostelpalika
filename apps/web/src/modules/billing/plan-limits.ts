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

/**
 * The plan whose caps hold: the paid plan chosen, else — once a trial has run
 * out with nothing bought — the free tier. No plan and no trial (hostels from
 * before trials), or a trial still running, is no ceiling. **Pure.**
 */
export function planForCaps(
  catalog: PlansCatalog,
  subscription: { planId?: string | null; trialEndsAt?: Date | null } | null,
  now = new Date(),
): Pick<PlanTierLike, "maxResidents" | "name" | "portalAccess"> | null {
  if (!subscription) return null;
  if (subscription.planId) return getPlan(catalog, subscription.planId) ?? null;
  if (!subscription.trialEndsAt || subscription.trialEndsAt.getTime() > now.getTime()) return null;

  return catalog.free ?? null;
}

/** Throws `PLAN_LIMIT_REACHED` (and tells the admins) when `adding` more would pass the plan's cap. */
export async function assertPlanRoom(hostelId: Types.ObjectId, seat: PlanSeat, adding = 1) {
  // A branch is on its main hostel's plan; its own seats are counted against it.
  const subscription = await HostelSubscriptionModel.findOne({ hostelId: await billingHostelId(hostelId) })
    .select("planId trialEndsAt")
    .lean<{ planId?: string | null; trialEndsAt?: Date | null } | null>();

  const catalog = await getSiteConfigSection("plans");
  const plan = planForCaps(catalog, subscription);
  const cap = !plan ? null : seat === "residents" ? plan.maxResidents : plan.portalAccess[seat];

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
