import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listTransfersDue } from "@/modules/bookings/booking-transfer.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Refunds and payouts to send, oldest first. `?kind=REFUND|PAYOUT`. */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    const kind = request.nextUrl.searchParams.get("kind");

    return withEtag(request, successResponse(
      { transfers: await listTransfersDue(kind === "REFUND" || kind === "PAYOUT" ? kind : undefined) },
      "Money to send",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
