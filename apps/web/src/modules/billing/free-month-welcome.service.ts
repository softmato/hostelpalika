import type { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { Role } from "@/lib/roles";
import { freeMonthOf } from "@/modules/billing/free-months";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { UserModel } from "@hostel/db/models/User";
import { formatBsDate } from "@hostel/shared/calendar/bs";

/**
 * "Welcome — enjoy the free Go plan this month" as a bell + push, once in each
 * free month, to the hostel's admins.
 *
 * Runs on the `FREE_MONTH_MORNING` automatic push row (08:00). Each month is
 * claimed on the subscription (`freeMonthsWelcomed`) before anything is sent,
 * so overlapping runs send one, and a month whose first morning was missed —
 * a hostel that went live at noon — is welcomed on the next one.
 *
 * Facts only: it goes to the app too, where the plan may not be sold.
 */
export function composeFreeMonthWelcome(input: {
  endsAt: Date;
  left: number;
  planName: string | null;
}) {
  const plan = input.planName ? `${input.planName} plan` : "plan";

  return {
    body:
      input.left > 0
        ? `${input.left} more free ${input.left === 1 ? "month" : "months"} after this one. This month is free until ${formatBsDate(input.endsAt)}.`
        : `This is your last free month, free until ${formatBsDate(input.endsAt)}.`,
    title: `Welcome — enjoy the free ${plan} this month`,
  };
}

export async function sendFreeMonthWelcomes(input: { now?: Date } = {}) {
  await connectToDatabase();

  const now = input.now ?? new Date();
  const totals = { devices: 0, recipients: 0 };
  const subscriptions = await HostelSubscriptionModel.find({
    freeUntil: { $gte: now },
    status: "ACTIVE",
  }).lean<
    Array<{
      _id: Types.ObjectId;
      activatedAt?: Date | null;
      freeMonths?: number | null;
      freeUntil?: Date | null;
      hostelId: Types.ObjectId;
      planName?: string | null;
    }>
  >();

  for (const subscription of subscriptions) {
    const month = freeMonthOf(subscription, now);

    if (!month) continue;

    const hostel = await HostelModel.findById(subscription.hostelId)
      .select("isDeleted status")
      .lean<{ isDeleted?: boolean; status?: string } | null>();

    if (!hostel || hostel.isDeleted || hostel.status !== "PUBLISHED") continue;

    // The claim: only one run moves this month into the list.
    const claimed = await HostelSubscriptionModel.updateOne(
      { _id: subscription._id, freeMonthsWelcomed: { $ne: month.month } },
      { $push: { freeMonthsWelcomed: month.month } },
    );

    if (!claimed.modifiedCount) continue;

    const admins = await UserModel.find({
      hostelIds: subscription.hostelId,
      isDeleted: { $ne: true },
      role: Role.HOSTEL_ADMIN,
    })
      .select("_id")
      .lean<Array<{ _id: Types.ObjectId }>>();

    const message = composeFreeMonthWelcome({ ...month, planName: subscription.planName ?? null });

    await Promise.all(
      admins.map((admin) =>
        createInAppNotification({
          ...message,
          category: "GENERAL",
          data: { freeMonth: month.month, type: "PLAN_FREE_MONTH" },
          hostelId: subscription.hostelId.toString(),
          priority: "NORMAL",
          userId: admin._id.toString(),
        }).catch(() => null),
      ),
    );

    totals.recipients += admins.length;
  }

  return totals;
}
