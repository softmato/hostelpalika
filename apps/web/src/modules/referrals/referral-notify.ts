import type { Types } from "mongoose";

import { createInAppNotification } from "@/modules/notifications/notification.service";
import { getHostelName } from "@/modules/residents/resident-notify";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";

/**
 * Telling a referrer what happened to the person they referred.
 *
 * ## Why this exists
 *
 * A referral is the one thing in this product a resident does *for* the hostel,
 * and it was the least communicative flow in it. They hand their code to a
 * friend and then nothing ever reaches them again: the friend joins silently,
 * the reward is approved silently, and the reward is paid silently. The only
 * way to find out was to ask the office — which is precisely the effort the
 * referral programme exists to be worth more than.
 *
 * A reward nobody is told about does not motivate anybody, so this is closer to
 * making the feature work than to decorating it.
 *
 * ## Which states are worth saying out loud
 *
 * `PENDING` is bookkeeping — the row exists the moment a reward is contemplated,
 * and announcing it would promise something the hostel has not agreed to yet.
 * `APPROVED` and `PAID` are both real events for the referrer.
 *
 * `CANCELLED` is announced **only when we already told them good news**. A
 * reward cancelled out of `PENDING` was never promised, so a "your reward was
 * cancelled" for it is the first and last they would ever hear of a reward they
 * did not know existed. One cancelled after approval is a promise being
 * withdrawn, and staying quiet about that is worse than the awkwardness of
 * saying it.
 *
 * ## Nothing here may fail the referral update
 *
 * The rule every notifier in this codebase holds.
 */

/** Referrals concern money, so a tap lands on the resident's payments. */
const CATEGORY = "PAYMENT";

/**
 * The referrer's user account, or `null`.
 *
 * A referrer is a `Resident`, and a resident may have no linked account — they
 * can be registered at a desk phone-only. There is nothing to notify then, and
 * that is an ordinary outcome rather than a failure.
 */
async function referrerUserId(
  referrerResidentId: Types.ObjectId | string,
): Promise<string | null> {
  const resident = await ResidentModel.findOne({ _id: referrerResidentId })
    .select({ userId: 1 })
    .lean<{ userId?: Types.ObjectId } | null>();

  if (!resident?.userId) {
    return null;
  }

  // A deleted account keeps its resident row; writing to it is writing a row
  // nobody will read. Same check `resolveHostelStaffUserIds` makes.
  const user = await UserModel.findOne({
    _id: resident.userId,
    isDeleted: { $ne: true },
  })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId } | null>();

  return user ? user._id.toString() : null;
}

/**
 * Somebody they referred has actually moved in.
 *
 * Sent on confirmation rather than on the inquiry, because an inquiry is a
 * stranger clicking a link and a confirmation is a person with a bed. The
 * referrer's reward is only owed for the second.
 */
export async function notifyReferralJoined(input: {
  hostelId: Types.ObjectId | string;
  referrerResidentId: Types.ObjectId | string;
}): Promise<void> {
  try {
    const userId = await referrerUserId(input.referrerResidentId);

    if (!userId) {
      return;
    }

    const hostelName = await getHostelName(input.hostelId);

    await createInAppNotification({
      body: `Someone you referred has joined ${hostelName}. Your reward is with the hostel office.`,
      category: CATEGORY,
      data: { kind: "REFERRAL_JOINED" },
      hostelId: input.hostelId.toString(),
      priority: "NORMAL",
      title: "Your referral joined",
      userId,
    });
  } catch (error) {
    warn("referral_joined_notification_failed", error);
  }
}

export async function notifyReferralReward(input: {
  amount: number;
  hostelId: Types.ObjectId | string;
  /** What the reward was before this edit, so a cancellation can be judged. */
  previousStatus: string | null;
  referrerResidentId: Types.ObjectId | string;
  rewardType: string;
  status: string;
}): Promise<void> {
  try {
    const notice = rewardNotice(input);

    if (!notice) {
      return;
    }

    const userId = await referrerUserId(input.referrerResidentId);

    if (!userId) {
      return;
    }

    const hostelName = await getHostelName(input.hostelId);

    await createInAppNotification({
      body: notice.body(hostelName),
      category: CATEGORY,
      data: { kind: "REFERRAL_REWARD", status: input.status },
      hostelId: input.hostelId.toString(),
      priority: "NORMAL",
      title: notice.title,
      userId,
    });
  } catch (error) {
    warn("referral_reward_notification_failed", error);
  }
}

function rewardNotice(input: {
  amount: number;
  previousStatus: string | null;
  rewardType: string;
  status: string;
}): { body: (hostelName: string) => string; title: string } | null {
  /*
   * The amount is only quoted when there is one. A `SERVICE_CREDIT` or `OTHER`
   * reward is routinely recorded with `amount` left at its default of 0, and
   * "your reward of NPR 0" reads as a bug or an insult depending on the reader.
   */
  const worth = input.amount > 0 ? ` of Rs ${input.amount.toLocaleString("en-US")}` : "";
  const kind = describeReward(input.rewardType);

  if (input.status === "APPROVED") {
    return {
      body: (hostelName) =>
        `${hostelName} approved your referral ${kind}${worth}. It is not paid out yet.`,
      title: "Your referral reward is approved",
    };
  }

  if (input.status === "PAID") {
    return {
      body: (hostelName) => `${hostelName} has paid your referral ${kind}${worth}.`,
      title: "Your referral reward is paid",
    };
  }

  // Only when a promise is being withdrawn — see the note at the top.
  if (
    input.status === "CANCELLED" &&
    (input.previousStatus === "APPROVED" || input.previousStatus === "PAID")
  ) {
    return {
      body: (hostelName) =>
        `${hostelName} has cancelled your referral ${kind}. Speak to the hostel office.`,
      title: "Your referral reward was cancelled",
    };
  }

  return null;
}

function describeReward(rewardType: string) {
  switch (rewardType) {
    case "CASH":
      return "cash reward";
    case "DISCOUNT":
      return "discount";
    case "SERVICE_CREDIT":
      return "service credit";
    default:
      return "reward";
  }
}

function warn(action: string, error: unknown) {
  console.warn(
    JSON.stringify({
      action,
      level: "warn",
      message: error instanceof Error ? error.message : "Unknown notification error",
    }),
  );
}
