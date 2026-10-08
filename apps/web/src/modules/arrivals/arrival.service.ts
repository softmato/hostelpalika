import { Types } from "mongoose";
import { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { HostelModel } from "@hostel/db/models/Hostel";
import { NotificationModel } from "@hostel/db/models/Notification";
import { UserModel } from "@hostel/db/models/User";
import { createInAppNotification } from "@/modules/notifications/notification.service";
import { resolveHostelStaffUserIds } from "@/modules/residents/resident-notify";

/**
 * "I'm on my way" — a signed-in person navigating to a hostel tells its staff
 * when they will get there.
 *
 * Only the arrival time crosses: never a position, never a route. The staff
 * row says who, how (walking or by vehicle) and roughly when — enough to have
 * someone at the gate, and nothing a location history could be built from.
 */

export const ARRIVAL_CATEGORY = "ARRIVAL";

/** One heads-up per person per hostel in this window; the second is a no-op. */
const REPEAT_WINDOW_MS = 10 * 60_000;

export const arrivalSchema = z.object({
  minutes: z.number().int().min(1).max(600),
  mode: z.enum(["car", "foot"]),
});

export class ArrivalError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number,
  ) {
    super(message);
  }
}

export async function announceArrival(
  hostelRef: string,
  input: z.infer<typeof arrivalSchema>,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const hostel = await HostelModel.findOne({
    ...(Types.ObjectId.isValid(hostelRef) ? { _id: new Types.ObjectId(hostelRef) } : { slug: hostelRef }),
    isDeleted: false,
    status: "PUBLISHED",
  })
    .select("name")
    .lean<{ _id: Types.ObjectId; name: string } | null>();

  if (!hostel) {
    throw new ArrivalError("Hostel not found.", "HOSTEL_NOT_FOUND", 404);
  }

  const staff = (await resolveHostelStaffUserIds(hostel._id)).filter(
    (userId) => userId !== principal.userId,
  );

  if (staff.length === 0) {
    return { sent: false };
  }

  // Checked on one staff member's rows — `userId` is indexed there.
  const recent = await NotificationModel.exists({
    category: ARRIVAL_CATEGORY,
    createdAt: { $gte: new Date(Date.now() - REPEAT_WINDOW_MS) },
    "data.travellerId": principal.userId,
    userId: new Types.ObjectId(staff[0]),
  });

  if (recent) {
    return { sent: true };
  }

  const traveller = await UserModel.findById(principal.userId)
    .select("name")
    .lean<{ name?: string } | null>();
  const who = traveller?.name?.trim() || "Someone";
  const how = input.mode === "foot" ? "walking" : "by vehicle";

  await Promise.all(
    staff.map((userId) =>
      createInAppNotification({
        body: `${who} is on the way to ${hostel.name} ${how} — about ${input.minutes} min away.`,
        category: ARRIVAL_CATEGORY,
        data: { minutes: input.minutes, mode: input.mode, travellerId: principal.userId },
        hostelId: hostel._id.toString(),
        title: `${who} is coming`,
        userId,
      }),
    ),
  );

  return { sent: true };
}
