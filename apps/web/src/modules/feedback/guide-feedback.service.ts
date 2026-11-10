import { Types } from "mongoose";
import { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { GuideFeedbackModel } from "@hostel/db/models/GuideFeedback";

/** "Is this page useful?" on the public guide — the Go twin is feedback/guide.go. */

export const guideFeedbackSchema = z.object({
  helpful: z.boolean(),
  page: z.string().trim().min(1).max(200).regex(/^\/guide(\/[a-z0-9-]{1,80}){0,2}$/, "Unknown page."),
  reason: z.string().trim().max(1000).optional(),
});

export async function createGuideFeedback(principal: ApiPrincipal | null, input: z.infer<typeof guideFeedbackSchema>) {
  await connectToDatabase();

  const created = await GuideFeedbackModel.create({
    helpful: input.helpful,
    page: input.page,
    // A reason only means something on a "No".
    reason: !input.helpful && input.reason ? input.reason : undefined,
    role: principal?.role,
    userId: principal ? new Types.ObjectId(principal.userId) : undefined,
  });

  return { id: String(created._id) };
}

/** Tally per page, worst first, plus the newest 200 reasons. */
export async function listGuideFeedback() {
  await connectToDatabase();

  const [tallies, rows] = await Promise.all([
    GuideFeedbackModel.aggregate<{ _id: string; helpful: number; notHelpful: number }>([
      {
        $group: {
          _id: "$page",
          helpful: { $sum: { $cond: ["$helpful", 1, 0] } },
          notHelpful: { $sum: { $cond: ["$helpful", 0, 1] } },
        },
      },
    ]),
    GuideFeedbackModel.find({ reason: { $exists: true } })
      .sort({ createdAt: -1 })
      .limit(200)
      .lean<Array<{ _id: Types.ObjectId; createdAt: Date; page: string; reason: string; role?: string }>>(),
  ]);

  return {
    pages: tallies
      .sort((a, b) => b.notHelpful - a.notHelpful || b.helpful - a.helpful || (a._id < b._id ? -1 : a._id > b._id ? 1 : 0))
      .map((t) => ({ page: t._id, helpful: t.helpful, notHelpful: t.notHelpful })),
    reasons: rows.map((r) => ({
      createdAt: r.createdAt.toISOString(),
      id: String(r._id),
      page: r.page,
      reason: r.reason,
      role: r.role ?? null,
    })),
  };
}
