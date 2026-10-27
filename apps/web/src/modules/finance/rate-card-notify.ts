import { roomTypeLabel } from "@hostel/shared/constants/room-types";
import type { Types } from "mongoose";

import { bsPeriodOf, formatBsPeriod } from "@/lib/hostel-day";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { getHostelName } from "@/modules/residents/resident-notify";
import { ResidentModel } from "@hostel/db/models/Resident";
import { UserModel } from "@hostel/db/models/User";

import type { FeeScheduleRate } from "@/modules/finance/fee-schedule.service";

/**
 * Telling residents that the price of their room has changed.
 *
 * ## Why this exists
 *
 * The rate card is the only price in the product — the public listing and every
 * pricing field are projected from it, and the billing run reads it to decide
 * what each resident owes. So an owner editing it changes what somebody pays,
 * and until this module ran, it changed it **silently**. The resident found out
 * when an invoice arrived for a different number than the one they agreed to,
 * which is the worst possible way to learn it and the shape of a dispute the
 * hostel cannot win: nothing had told them, so nothing can show they were told.
 *
 * A rate card is always dated to a future month (`FEE_SCHEDULE_MONTH_LOCKED`
 * refuses anything else), which is what makes the notification worth sending
 * rather than merely polite — there is time to ask about it, or leave.
 *
 * ## Only the residents whose own rent moved
 *
 * Everyone gets *their* number, not the card. A resident in a four-sharing room
 * does not care what a single room now costs, and a card that changed only the
 * admission fee has changed nothing at all for anybody already living there —
 * telling them "your rent has changed" would be false.
 *
 * So each active resident is matched to the rate for their `roomType` in both
 * the outgoing and incoming card, and is written to only when those two differ.
 * A resident whose room type is absent from the new card is skipped rather than
 * guessed at: that is a gap in the card, and inventing a number for it would be
 * worse than the silence this module exists to end.
 *
 * ## Nothing here may fail the rate change
 *
 * Same rule the invoices and the listing projection already hold. By the time
 * this runs the card is written and is what the next billing run will read. A
 * notification that threw would report "could not save rates" over rates that
 * were saved, and the owner would type them again — landing on the
 * already-changed path with a card that now looks wrong.
 */
export async function notifyRateCardChanged(input: {
  effectiveFrom: Date;
  hostelId: Types.ObjectId | string;
  /** The card being replaced, or `null` when this hostel is pricing its first. */
  previousRates: FeeScheduleRate[] | null;
  rates: FeeScheduleRate[];
}): Promise<void> {
  try {
    /*
     * A hostel's first card has priced nobody. Any resident already living
     * there predates it and is billed from it going forward, but "your rent has
     * changed from X" has no X to name — so there is nothing honest to say and
     * the first card stays quiet.
     */
    if (!input.previousRates) {
      return;
    }

    const before = ratesByRoomType(input.previousRates);
    const after = ratesByRoomType(input.rates);

    // Nothing about the rent moved. An admission-fee or deposit edit reaches
    // nobody who is already living here, because it does not apply to them.
    if ([...after].every(([roomType, amount]) => before.get(roomType) === amount)) {
      return;
    }

    const residents = await ResidentModel.find({
      hostelId: input.hostelId,
      isDeleted: false,
      status: "ACTIVE",
      userId: { $ne: null },
    })
      .select({ roomType: 1, userId: 1 })
      .lean<{ roomType?: string; userId?: Types.ObjectId }[]>();

    if (residents.length === 0) {
      return;
    }

    /*
     * Checked against `User` for the same reason `resolveHostelStaffUserIds`
     * does it: a deleted account can keep its resident row, and a notification
     * written to it is a row nobody will ever read.
     */
    const live = await liveUserIds(residents.map((resident) => resident.userId));

    if (live.size === 0) {
      return;
    }

    const hostelName = await getHostelName(input.hostelId);
    const month =
      formatBsPeriod(bsPeriodOf(input.effectiveFrom)) ||
      input.effectiveFrom.toISOString().slice(0, 10);

    await Promise.all(
      residents.map(async (resident) => {
        const userId = resident.userId?.toString();
        const roomType = resident.roomType;

        if (!userId || !roomType || !live.has(userId)) {
          return;
        }

        const next = after.get(roomType);
        const current = before.get(roomType);

        // Absent from the new card, or unchanged for this room type — see above.
        if (next === undefined || next === current) {
          return;
        }

        await createInAppNotification({
          body:
            current === undefined
              ? `From ${month}, ${roomTypeLabel(roomType)} at ${hostelName} is NPR ${next.toLocaleString("en-US")} a month.`
              : `From ${month}, your rent ${next > current ? "rises" : "falls"} from NPR ${current.toLocaleString("en-US")} to NPR ${next.toLocaleString("en-US")} a month.`,
          category: "PAYMENT",
          data: { effectiveFrom: input.effectiveFrom.toISOString(), roomType },
          hostelId: input.hostelId.toString(),
          priority: "NORMAL",
          title: next > (current ?? 0) ? "Your rent is going up" : "Your rent is changing",
          userId,
        });
      }),
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "rate_card_notification_failed",
        hostelId: input.hostelId.toString(),
        level: "warn",
        message: error instanceof Error ? error.message : "Unknown notification error",
      }),
    );
  }
}

/**
 * The monthly amount per room type.
 *
 * Keyed on `roomType` — the hostel's own vocabulary and the key billing uses —
 * rather than on `bedType`, which is a derived reporting label two different
 * room types can share.
 */
function ratesByRoomType(rates: FeeScheduleRate[]): Map<string, number> {
  const byRoomType = new Map<string, number>();

  for (const rate of rates) {
    if (rate.roomType) {
      byRoomType.set(rate.roomType, rate.monthlyAmount);
    }
  }

  return byRoomType;
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
