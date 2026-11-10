import { Types } from "mongoose";
import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { connectToDatabase } from "@/lib/db";
import { getPlanUsage } from "@/modules/billing/plan-limits";

export const runtime = "nodejs";

/**
 * The plan the hostel is on, its caps, what it uses, and — on the free tier
 * over its caps — when the portal turns read-only. Billing, Home and the
 * plan chooser read it. Scoped to the principal's hostel, like `/billing`.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const hostelId = principal.hostelIds?.[0];

    if (!hostelId) return successResponse({ usage: null }, "No hostel in scope");

    await connectToDatabase();

    return successResponse({ usage: await getPlanUsage(new Types.ObjectId(hostelId)) }, "Plan usage loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}
