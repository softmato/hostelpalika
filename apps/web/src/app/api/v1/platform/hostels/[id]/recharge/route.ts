import type { NextRequest } from "next/server";
import { z } from "zod";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { rechargeSubscription } from "@/modules/billing/subscription.service";
import { liftHostelSuspension } from "@/modules/hostels/hostel-suspension";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

const rechargeSchema = z.object({
  months: z.coerce.number().int().min(1).max(12),
  planId: z.string().trim().min(1),
});

/**
 * Superadmin recharge: adds months of a plan on top of what the hostel has
 * running and makes that plan the live one. No payment is taken or checked.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const { id } = await context.params;
    const input = rechargeSchema.parse(await request.json());
    const result = await rechargeSubscription(id, input, principal.userId);

    // Recharged means paid up, so a running suspension has no reason left.
    await liftHostelSuspension(id, { actorId: principal.userId, cause: "LIFTED" });

    return successResponse(result, "Plan recharged");
  } catch (error) {
    return handleRouteError(error);
  }
}
