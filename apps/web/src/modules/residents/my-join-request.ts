import { Types } from "mongoose";

import { connectToDatabase } from "@/lib/db";
import { HostelModel } from "@hostel/db/models/Hostel";
import { ResidentApplicationModel } from "@hostel/db/models/ResidentApplication";
import { ResidentJoinLinkModel } from "@hostel/db/models/ResidentJoinLink";

/**
 * The signed-in person's own open join request — waiting, or sent back to fix —
 * so the app can show it on their home instead of making them find the link
 * again. Added requests drop out: by then they are a resident.
 *
 * Kept apart from `resident-join.service.ts` on purpose: that one reaches the
 * sheet reader and the PDF library (`lib/output-tracing.ts`), and this route
 * needs neither.
 */
export async function getMyJoinRequest(userId: string) {
  await connectToDatabase();

  const request = await ResidentApplicationModel.findOne({
    status: { $in: ["PENDING", "REJECTED"] },
    userId: new Types.ObjectId(userId),
  })
    .sort({ updatedAt: -1 })
    .select("hostelId rejectReason status")
    .lean<{ hostelId: Types.ObjectId; rejectReason?: string; status: "PENDING" | "REJECTED" } | null>();

  if (!request) return { request: null };

  // One link per hostel, so by hostel: a request sent before `linkId` existed still finds it.
  const [link, hostel] = await Promise.all([
    ResidentJoinLinkModel.findOne({ hostelId: request.hostelId }).select("token").lean<{ token: string } | null>(),
    HostelModel.findOne({ _id: request.hostelId, isDeleted: { $ne: true } })
      .select("name")
      .lean<{ name?: string } | null>(),
  ]);

  if (!link || !hostel) return { request: null };

  return {
    request: {
      hostelName: hostel.name?.trim() || "Your hostel",
      reason: request.rejectReason ?? "",
      status: request.status,
      token: link.token,
    },
  };
}
