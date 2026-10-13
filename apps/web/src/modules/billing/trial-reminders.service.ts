import type { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { siteUrl } from "@/lib/site";
import { planPayLink } from "@/modules/billing/plan-pay-link";
import { notifyHostelOwnerOf } from "@/modules/hostels/hostel-notify";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";
import { formatEmailDate, hostelBillingUrl } from "@/modules/hostels/hostel-registration.events";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { UserModel } from "@hostel/db/models/User";
import { hostelDayEnd, hostelDaysBetween } from "@hostel/shared/calendar/bs";
import { sendEmail } from "@hostel/shared/email/sender";
import { hostelTrialEndingEmail } from "@hostel/shared/email/templates/hostel/hostel-kyc";

/**
 * "Your free trial ends in 3 days" and "…ends today", once each, to the owner
 * of a hostel on the trial with no plan bought (docs/QUICK_SIGNUP_KYC_TRIAL.md).
 *
 * A trial that already has a plan is the renewal sweep's — its first bill is
 * raised and reminded about like any other. A hostel whose KYC is not approved
 * yet is asked for the KYC instead: a plan cannot be bought before it is
 * verified, and past the trial its portal is closed until it is.
 *
 * Email carries the website's Billing link; the push is facts only, because it
 * reaches the app, where the plan may not be sold.
 */

/** Days-left marks, each claimed once in `trialReminded`. */
export const TRIAL_REMINDER_MARKS = [3, 0] as const;

/** Which mark a trial with `daysLeft` is at. **Pure.** */
export function trialReminderMark(daysLeft: number) {
  return daysLeft <= 0 ? 0 : daysLeft <= 3 ? 3 : null;
}

export async function sendTrialEndingReminders(now = new Date()) {
  await connectToDatabase();

  const totals = { sent: 0 };
  // ponytail: one unpaged read, like the renewal sweep next door; page by `_id` at thousands.
  const trials = await HostelSubscriptionModel.find({
    lifetimeSince: null,
    planId: null,
    trialEndsAt: { $gte: now, $lte: hostelDayEnd(now, 3) },
  })
    .select("hostelId trialEndsAt trialReminded")
    .lean<Array<{ _id: Types.ObjectId; hostelId: Types.ObjectId; trialEndsAt: Date; trialReminded?: number[] }>>();

  for (const trial of trials) {
    const daysLeft = hostelDaysBetween(now, trial.trialEndsAt);
    const mark = trialReminderMark(daysLeft);

    if (mark === null || trial.trialReminded?.includes(mark)) continue;

    const hostel = await HostelModel.findById(trial.hostelId)
      .select("isDeleted kyc name ownerId slug")
      .lean<{
        isDeleted?: boolean;
        kyc?: { required?: boolean; status?: string | null };
        name?: string;
        ownerId?: Types.ObjectId;
        slug?: string;
      } | null>();

    if (!hostel || hostel.isDeleted || !hostel.ownerId) continue;

    // Not approved yet: the plan cannot be bought, so the reminder asks for the KYC first.
    const kycPending = Boolean(hostel.kyc?.required) && hostel.kyc?.status !== "APPROVED";

    // The claim: overlapping runs send one.
    const claimed = await HostelSubscriptionModel.updateOne(
      { _id: trial._id, trialReminded: { $ne: mark } },
      { $push: { trialReminded: mark } },
    );

    if (!claimed.modifiedCount) continue;

    const owner = await UserModel.findById(hostel.ownerId)
      .select("email name")
      .lean<{ email?: string; name?: string } | null>();

    if (owner?.email) {
      await sendEmail({
        to: owner.email,
        ...hostelTrialEndingEmail({
          billingUrl: await planPayLink({ id: String(trial.hostelId) }, hostelBillingUrl(hostel.slug ?? "")),
          daysLeft,
          hostelName: hostel.name ?? "Your hostel",
          kycPending,
          kycUrl: `${siteUrl()}/${encodeURIComponent(hostel.slug ?? "")}/admin/kyc`,
          supportPhone: (await getSiteConfigSection("identity")).supportPhone || null,
          ownerName: owner.name,
          trialEndsOn: formatEmailDate(trial.trialEndsAt) ?? "",
        }),
      }).catch(() => null);
    }

    await notifyHostelOwnerOf(hostel.ownerId, trial.hostelId, {
      actionUrl: kycPending ? "/hostel-admin/kyc" : "/hostel-admin/billing",
      body: kycPending
        ? "Complete your KYC to keep your hostel portal open after the trial."
        : "Please check your email to choose a monthly or lifetime plan.",
      title: daysLeft <= 0 ? "Your free trial ends today" : `Your free trial ends in ${daysLeft} ${daysLeft === 1 ? "day" : "days"}`,
      type: kycPending ? "HOSTEL_KYC" : "HOSTEL_TRIAL",
    });

    totals.sent += 1;
  }

  return totals;
}
