import { Types } from "mongoose";

import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { getPlan } from "@hostel/shared/plans/catalog";

/**
 * The hostel a plan is billed against.
 *
 * A branch has no plan of its own: it rides its main hostel's (Max) plan, so
 * every read of "this hostel's plan" — state, limits, billing history, the
 * invoice to pay — is asked of the main one. For any other hostel this is the
 * hostel itself.
 */
export async function billingHostelId(hostelId: string | Types.ObjectId) {
  const id = typeof hostelId === "string" ? new Types.ObjectId(hostelId) : hostelId;
  const hostel = await HostelModel.findById(id)
    .select("parentHostelId")
    .lean<{ parentHostelId?: Types.ObjectId | null } | null>();

  return hostel?.parentHostelId ?? id;
}

/** Branches this hostel's plan includes — 0 on every plan but Max. A branch answers for its main hostel. */
export async function planBranchCap(hostelId: string | Types.ObjectId) {
  const subscription = await HostelSubscriptionModel.findOne({ hostelId: await billingHostelId(hostelId) })
    .select("planId")
    .lean<{ planId?: string | null } | null>();

  if (!subscription?.planId) return 0;

  return getPlan(await getSiteConfigSection("plans"), subscription.planId)?.maxBranches ?? 0;
}

/** Live branches of a main hostel — pending ones count, they hold a place under the cap. */
export function countBranches(mainHostelId: Types.ObjectId) {
  return HostelModel.countDocuments({
    isDeleted: { $ne: true },
    parentHostelId: mainHostelId,
    status: { $ne: "REJECTED" },
  });
}

/**
 * Refuses a plan that cannot carry the branches this hostel already has — a Max
 * hostel with two branches cannot renew on Go. Removing branches is the way
 * down, not a plan that silently strands them.
 */
export async function assertBranchesFit(mainHostelId: Types.ObjectId, planId: string) {
  const branches = await countBranches(mainHostelId);

  if (branches === 0) return;

  const plan = getPlan(await getSiteConfigSection("plans"), planId);
  const cap = plan?.maxBranches ?? 0;

  if (branches > cap) {
    throw Object.assign(
      new Error(
        `This hostel has ${branches} ${branches === 1 ? "branch" : "branches"}, and ${plan?.name ?? "that plan"} allows ${cap}. Keep a plan with branches, or remove branches first.`,
      ),
      { errorCode: "PLAN_HAS_TOO_FEW_BRANCHES", status: 409 },
    );
  }
}
