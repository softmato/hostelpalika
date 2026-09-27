import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { raiseRenewalInvoice } from "@/modules/billing/subscription.service";
import { onInvoiceIssued } from "@/modules/hostels/hostel-registration.events";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";
import { HostelModel } from "@hostel/db/models/Hostel";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { SubscriptionInvoiceModel } from "@hostel/db/models/SubscriptionInvoice";
import { UserModel } from "@hostel/db/models/User";
import { hostelDayEnd } from "@hostel/shared/calendar/bs";
import type { BillingCycle } from "@hostel/shared/plans/catalog";

/**
 * The next bill, raised before the plan runs out.
 *
 * Nothing raised a plan's next invoice on its own before this: a hostel paid
 * when it chose to, and a plan that ran out simply stayed "active". Free
 * months made that a hole — every hostel on them reaches the end with nothing
 * to pay — so once a day, for every live plan ending within
 * {@link RENEW_AHEAD_DAYS}, this raises the bill for the plan and cycle the
 * hostel is on, due the day the running period ends, and emails it.
 *
 * The first bill after the free months is priced as agreed when the plan was
 * chosen (the subscription's snapshot); later ones at today's catalogue, like
 * a renewal the owner starts themselves.
 *
 * A plan whose period has ended with that bill still open becomes `PAST_DUE`,
 * which is what the due banners, the after-due reminders and a superadmin's
 * Suspend already read.
 *
 * Runs on the 07:45 `payment-reminders` cron, ahead of the 08:00 plan
 * reminders that then pick the bill up (7 and 5 days out, then daily).
 */

/** Days before a period ends that its next bill is raised — the first early reminder's. */
export const RENEW_AHEAD_DAYS = 7;

type Row = {
  _id: Types.ObjectId;
  currentPeriodEnd: Date;
  cycle?: BillingCycle | null;
  cycleMonths?: number | null;
  cycleTotal?: number | null;
  freeUntil?: Date | null;
  hostelId: Types.ObjectId;
  monthlyRate?: number | null;
  planId?: string | null;
  planName?: string | null;
};

export async function raiseDueRenewals(now = new Date()) {
  await connectToDatabase();

  // ponytail: one unpaged read, like the plan reminders next door; page by `_id` at thousands.
  const subscriptions = await HostelSubscriptionModel.find({
    currentPeriodEnd: { $lte: hostelDayEnd(now, RENEW_AHEAD_DAYS), $ne: null },
    planId: { $ne: null },
    status: "ACTIVE",
  }).lean<Row[]>();

  const totals = { failed: 0, lapsed: 0, raised: 0 };

  if (subscriptions.length === 0) {
    return totals;
  }

  const catalog = await getSiteConfigSection("plans");

  for (const subscription of subscriptions) {
    try {
      const hostel = await HostelModel.findById(subscription.hostelId)
        .select("isDeleted name ownerId slug status")
        .lean<{
          isDeleted?: boolean;
          name?: string;
          ownerId?: Types.ObjectId;
          slug?: string;
          status?: string;
        } | null>();

      if (!hostel || hostel.isDeleted || hostel.status !== "PUBLISHED" || !subscription.cycle) {
        continue;
      }

      let open = await SubscriptionInvoiceModel.findOne({
        kind: { $ne: "SETUP_FEE" },
        status: { $in: ["OPEN", "PARTIAL"] },
        subscriptionId: subscription._id,
      })
        .sort({ createdAt: -1 })
        .lean<{ dueAt?: Date | null } | null>();

      if (!open) {
        const firstAfterFree =
          subscription.freeUntil?.getTime() === subscription.currentPeriodEnd.getTime() &&
          Boolean(subscription.cycleTotal && subscription.cycleMonths && subscription.planName);

        const { invoice } = await raiseRenewalInvoice(
          subscription.hostelId.toString(),
          { cycle: subscription.cycle, planId: subscription.planId as string },
          null,
          {
            agreed: firstAfterFree
              ? {
                  cycle: subscription.cycle,
                  cycleMonths: subscription.cycleMonths as number,
                  cycleTotal: subscription.cycleTotal as number,
                  freeMonths: 0,
                  monthlyRate: subscription.monthlyRate ?? 0,
                  planId: subscription.planId as string,
                  planName: subscription.planName as string,
                }
              : undefined,
            dueAt: subscription.currentPeriodEnd,
          },
        );

        const owner = hostel.ownerId
          ? await UserModel.findById(hostel.ownerId)
              .select("email name")
              .lean<{ email?: string; name?: string } | null>()
          : null;

        await onInvoiceIssued({
          amount: invoice.amount,
          cycleLabel: catalog.cycleLabels[invoice.cycle] ?? invoice.cycle,
          documentUrl: invoice.documentUrl ?? null,
          dueAt: invoice.dueAt ?? null,
          hostelLive: true,
          hostelName: hostel.name ?? "",
          hostelSlug: hostel.slug ?? null,
          invoiceNumber: invoice.invoiceNumber,
          ownerEmail: owner?.email,
          ownerName: owner?.name,
          planName: invoice.planName,
          source: "PUBLIC",
        });

        open = invoice;
        totals.raised += 1;
      }

      if (subscription.currentPeriodEnd.getTime() < now.getTime()) {
        await HostelSubscriptionModel.updateOne(
          { _id: subscription._id, status: "ACTIVE" },
          { $set: { dueBy: open.dueAt ?? subscription.currentPeriodEnd, status: "PAST_DUE" } },
        );
        totals.lapsed += 1;
      }
    } catch (error) {
      // One hostel's bill failing (a plan deleted from the catalogue, Softmato
      // refusing) must not stop everyone else's.
      totals.failed += 1;
      console.error(
        JSON.stringify({
          action: "plan_renewal_sweep_failed",
          level: "error",
          message: error instanceof Error ? error.message : String(error),
          subscriptionId: subscription._id.toString(),
        }),
      );
    }
  }

  return totals;
}
