import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { reviewHostelPayoutAccount } from "@/modules/bookings/payout-account.service";
import { payoutAccountReviewSchema } from "@/lib/bookings/payout-account.validation";

type RouteContext = { params: Promise<{ hostelId: string }> };

export const runtime = "nodejs";

/** Verify a payout account, or send it back with the reason. */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const { hostelId } = await context.params;
    const input = payoutAccountReviewSchema.parse(await request.json());
    const account = await reviewHostelPayoutAccount(hostelId, input, principal);

    return successResponse(
      { account },
      input.approve ? "Payout account verified" : "Payout account sent back",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
