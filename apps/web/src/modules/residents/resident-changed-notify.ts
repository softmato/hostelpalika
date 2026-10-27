import { roomTypeLabel } from "@hostel/shared/constants/room-types";
import type { Types } from "mongoose";

import { createInAppNotification } from "@/modules/notifications/notification.service";
import { getHostelName } from "@/modules/residents/resident-notify";

/**
 * Telling a resident about a change somebody else made to their record.
 *
 * ## Why this exists
 *
 * Registration was the loudest thing that could happen to a resident, and it
 * was already covered (`resident-registered-notify`). Everything *after* it was
 * silent: a warden could move somebody to a different room type, or suspend
 * their stay, and the only trace was an audit row nobody outside the office
 * reads. The resident found out by opening the app and noticing, or by turning
 * up at a bed that is no longer theirs.
 *
 * These are the two edits that change a person's living situation rather than
 * their paperwork, so these are the two that are announced.
 *
 * ## What is deliberately *not* announced
 *
 * - **Contact edits.** A warden fixing a mistyped phone number is correcting
 *   the record to match reality, and "your email was changed" over a typo fix
 *   is an alarming sentence about nothing.
 * - **Deletion.** Removing somebody from the roll is nearly always a duplicate
 *   or a mis-entry being cleaned up. A person who was never really registered
 *   should not be told their stay ended, and one who genuinely left has already
 *   had `MOVED_OUT` announced below.
 * - **A move to `PENDING`.** That is an administrative reversal, not a state
 *   anybody experiences.
 *
 * ## Nothing here may fail the edit
 *
 * The same rule every notifier in this codebase holds. By the time this runs the
 * write is committed and the bed has already moved; a throw would report failure
 * over a change that succeeded, and the warden would do it again.
 */

/** Where a tap should land: the resident's own profile, not the admin roll. */
const CATEGORY = "ACCOUNT";

/**
 * A change of room **type**, which is the only kind of move this product
 * records.
 *
 * There is deliberately no bed or room *number* here, because `Resident` has no
 * such field — a hostel's inventory is counted by type, and which bed somebody
 * is in is not modelled. So "moved rooms" always means "moved between room
 * types", and that is worth announcing precisely because it is also the thing
 * the rate card prices: a resident moved from four-sharing to a single room is
 * being told the one fact that changes what they owe.
 */
export async function notifyResidentRoomChanged(input: {
  hostelId: Types.ObjectId | string;
  previous: { roomType: string };
  resident: {
    roomType: string;
    userId?: Types.ObjectId | string | null;
  };
}): Promise<void> {
  const userId = input.resident.userId?.toString();

  if (!userId || input.previous.roomType === input.resident.roomType) {
    return;
  }

  try {
    const hostelName = await getHostelName(input.hostelId);

    await createInAppNotification({
      body: `You have been moved from ${roomTypeLabel(input.previous.roomType)} to ${roomTypeLabel(input.resident.roomType)} at ${hostelName}.`,
      category: CATEGORY,
      data: {
        previousRoomType: input.previous.roomType,
        roomType: input.resident.roomType,
      },
      hostelId: input.hostelId.toString(),
      priority: "NORMAL",
      title: "Your room has changed",
      userId,
    });
  } catch (error) {
    warn("resident_room_change_notification_failed", error);
  }
}

/**
 * A change of standing: admitted, suspended, or moved out.
 *
 * `SUSPENDED` is the one that most needed saying. It can stop somebody being
 * fed and can close their access, and it was reachable from a dropdown that
 * told nobody — so the person it happened to had to work out from the app's
 * behaviour that something had been done to them.
 */
export async function notifyResidentStatusChanged(input: {
  hostelId: Types.ObjectId | string;
  previousStatus: string;
  resident: { userId?: Types.ObjectId | string | null };
  status: string;
}): Promise<void> {
  const userId = input.resident.userId?.toString();

  if (!userId || input.status === input.previousStatus) {
    return;
  }

  try {
    const hostelName = await getHostelName(input.hostelId);
    const notice = STATUS_NOTICE[input.status]?.(hostelName);

    // PENDING, and anything a later migration adds. See the note above.
    if (!notice) {
      return;
    }

    await createInAppNotification({
      body: notice.body,
      category: CATEGORY,
      data: { previousStatus: input.previousStatus, status: input.status },
      hostelId: input.hostelId.toString(),
      priority: notice.priority,
      title: notice.title,
      userId,
    });
  } catch (error) {
    warn("resident_status_change_notification_failed", error);
  }
}

const STATUS_NOTICE: Record<
  string,
  ((hostelName: string) => {
    body: string;
    priority: "HIGH" | "NORMAL";
    title: string;
  }) | undefined
> = {
  ACTIVE: (hostelName) => ({
    body: `Your stay at ${hostelName} is now active.`,
    priority: "NORMAL",
    title: "You are admitted",
  }),
  MOVED_OUT: (hostelName) => ({
    body: `Your stay at ${hostelName} has been closed. Any deposit is settled separately.`,
    priority: "NORMAL",
    title: "Your stay has ended",
  }),
  /*
   * HIGH, alone among the three. The other two are news; this one is something
   * the resident may need to act on today — and it is the only status change
   * that can take away access they were relying on an hour ago.
   */
  SUSPENDED: (hostelName) => ({
    body: `Your stay at ${hostelName} has been suspended. Speak to the hostel office.`,
    priority: "HIGH",
    title: "Your stay is suspended",
  }),
};

function warn(action: string, error: unknown) {
  console.warn(
    JSON.stringify({
      action,
      level: "warn",
      message: error instanceof Error ? error.message : "Unknown notification error",
    }),
  );
}
