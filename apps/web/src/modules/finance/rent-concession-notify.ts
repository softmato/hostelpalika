import type { Types } from "mongoose";

import { createInAppNotification } from "@/modules/notifications/notification.service";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";

/**
 * Telling a resident that a bill they are already holding has changed.
 *
 * ## Why this is not optional
 *
 * `rate-card-notify` exists because an owner editing the rate card used to change
 * what somebody pays silently, and the resident found out when an invoice arrived
 * for a number they had not agreed to. A festival discount applied **after** the
 * month was billed is the same failure pointed the other way: the bill in their
 * hand said 8,000, our copy now says 4,000, and nothing told them which is real.
 * A resident who pays the 8,000 they were asked for then overpays by half a
 * month, and a resident who happens to open the app pays 4,000 — the same month,
 * the same hostel, two different answers depending on whether somebody looked.
 *
 * Good news needs saying as much as bad. It is also the thing the hostel most
 * wants said: the discount is a favour, and a favour nobody was told about buys
 * nothing.
 *
 * ## Only residents whose own bill moved
 *
 * The caller passes what actually changed per invoice — the old total, the new
 * one, and any credit that came out of it. A resident billed after the discount
 * was set never held a wrong bill and is not written to; their invoice arrived
 * correct.
 *
 * ## Nothing here may fail the correction
 *
 * The same rule the invoices, the listing projection and the rate-card notice
 * already hold. By the time this runs the money is right and the bills are
 * saved. A notification that threw would report "could not save the discount"
 * over a discount that was saved, and the owner would set it again.
 */

export type ConcessionChange = {
  /** The invoice total afterwards. */
  after: number;
  /** The invoice total before the discount was applied or withdrawn. */
  before: number;
  /** Rupees already paid that became credit. Zero for most. */
  credited: number;
  residentId: Types.ObjectId;
};

const npr = (amount: number) => `Rs ${amount.toLocaleString("en-US")}`;

export async function notifyRentConcession(input: {
  changes: ConcessionChange[];
  hostelId: Types.ObjectId | string;
  /** "Kartik 2083" — the month as a resident reads it. */
  monthName: string;
  /** "Dashain · 50% off", or null when the discount is being withdrawn. */
  note: string | null;
}): Promise<void> {
  try {
    if (input.changes.length === 0) {
      return;
    }

    const residents = await ResidentModel.find({
      _id: { $in: input.changes.map((change) => change.residentId) },
      isDeleted: false,
      userId: { $ne: null },
    })
      .select({ userId: 1 })
      .lean<{ _id: Types.ObjectId; userId?: Types.ObjectId }[]>();

    /*
     * Checked against `User` for the reason `rate-card-notify` gives: a deleted
     * account can keep its resident row, and a notification written to it is a
     * row nobody will ever read.
     */
    const live = await liveUserIds(residents.map((resident) => resident.userId));
    const userByResident = new Map(
      residents
        .filter((resident) => resident.userId && live.has(resident.userId.toString()))
        .map((resident) => [resident._id.toString(), resident.userId!.toString()]),
    );

    if (userByResident.size === 0) {
      return;
    }

    await Promise.all(
      input.changes.map(async (change) => {
        const userId = userByResident.get(change.residentId.toString());

        if (!userId) {
          return;
        }

        const reduced = change.after < change.before;

        /*
         * The credit sentence is a second line, not a replacement for the first.
         *
         * A resident who had already paid needs both facts: what the bill says
         * now, and where the money they have already sent went. Saying only "you
         * have 1,000 credit" leaves them unable to check it against anything.
         */
        const body = [
          reduced
            ? `Your ${input.monthName} bill is now ${npr(change.after)} instead of ${npr(change.before)}.`
            : `Your ${input.monthName} bill is back to ${npr(change.after)}.`,
          reduced && input.note ? `${input.note}.` : null,
          change.credited > 0
            ? `${npr(change.credited)} you had already paid is now credit towards your next bill.`
            : null,
        ]
          .filter(Boolean)
          .join(" ");

        await createInAppNotification({
          /*
           * `actionUrl` makes this an ACTION row, which is right: there is a
           * number to check and, for most of them, a smaller amount to pay. The
           * bell row on its own would leave them hunting for the bill.
           */
          actionUrl: "/resident/payments",
          body,
          category: "PAYMENT",
          data: { credited: change.credited, month: input.monthName },
          hostelId: input.hostelId.toString(),
          priority: "NORMAL",
          title: reduced ? "Your bill has gone down" : "Your bill has changed",
          userId,
        });
      }),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "rent_concession_notification_failed",
        hostelId: input.hostelId.toString(),
        level: "warn",
        message: error instanceof Error ? error.message : "Unknown notification error",
      }),
    );
  }
}

async function liveUserIds(
  ids: (Types.ObjectId | undefined)[],
): Promise<Set<string>> {
  const present = ids.filter(Boolean);

  if (present.length === 0) {
    return new Set();
  }

  const users = await UserModel.find({
    _id: { $in: present },
    isDeleted: { $ne: true },
  })
    .select({ _id: 1 })
    .lean<{ _id: Types.ObjectId }[]>();

  return new Set(users.map((user) => user._id.toString()));
}
