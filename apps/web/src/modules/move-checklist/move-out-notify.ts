import type { Types } from "mongoose";

import { createInAppNotification } from "@/modules/notifications/notification.service";
import { getHostelName } from "@/modules/residents/resident-notify";

/**
 * Telling somebody their stay is over, and what happened to their deposit.
 *
 * ## Why this is not covered by the status notifier
 *
 * `createMoveOutChecklist` writes `status: "MOVED_OUT"` with its own
 * `ResidentModel.updateOne`, rather than going through `updateResidentStatus`.
 * So the notification on that function — which does announce a move-out — never
 * fires on the path residents actually leave by. The dropdown was covered and
 * the real door was not.
 *
 * ## The deposit is the reason this matters
 *
 * A move-out checklist is also where the deposit is decided: refunded in full,
 * partially, or forfeited. That is the resident's own money, and the decision
 * was recorded, audited and then never communicated — the person who paid it
 * found out by asking, or did not find out at all.
 *
 * Which is why this is one notification rather than two. "Your stay has ended"
 * and "your deposit was forfeited" are the same conversation, and splitting them
 * into two rows would put the money news second.
 *
 * ## `PENDING` is a decision not yet taken
 *
 * A checklist saved with the deposit still undecided has nothing to report about
 * it, so the notice says the stay ended and explicitly that the deposit follows.
 * Promising a number that has not been agreed would be worse than saying it is
 * still open.
 *
 * Nothing here may fail the move-out: by the time it runs the bed is back in
 * the vacancy count and the resident is already MOVED_OUT.
 */
export async function notifyMoveOutCompleted(input: {
  depositAmount: number;
  depositDecision: string;
  hostelId: Types.ObjectId | string;
  resident: { userId?: Types.ObjectId | string | null };
}): Promise<void> {
  const userId = input.resident.userId?.toString();

  if (!userId) {
    return;
  }

  try {
    const hostelName = await getHostelName(input.hostelId);

    await createInAppNotification({
      body: `Your stay at ${hostelName} has been closed. ${describeDeposit(input.depositDecision, input.depositAmount)}`.trim(),
      category: "PAYMENT",
      data: {
        depositAmount: input.depositAmount,
        depositDecision: input.depositDecision,
        kind: "MOVE_OUT_COMPLETED",
      },
      hostelId: input.hostelId.toString(),
      priority: "NORMAL",
      title: "Your stay has ended",
      userId,
    });
  } catch (error) {
    console.warn(
      JSON.stringify({
        action: "move_out_notification_failed",
        level: "warn",
        message: error instanceof Error ? error.message : "Unknown notification error",
      }),
    );
  }
}

function describeDeposit(decision: string, amount: number) {
  const money = `Rs ${amount.toLocaleString("en-US")}`;

  switch (decision) {
    case "APPROVED":
      // No deposit was held, so there is nothing to say about one.
      return amount > 0 ? `Your deposit of ${money} is approved for refund.` : "";
    case "PARTIAL":
      return `${money} of your deposit is approved for refund; the rest is held against what was owed.`;
    case "FORFEITED":
      return "Your deposit has been forfeited. Speak to the hostel office if that is unexpected.";
    default:
      return "Your deposit is still being settled.";
  }
}
