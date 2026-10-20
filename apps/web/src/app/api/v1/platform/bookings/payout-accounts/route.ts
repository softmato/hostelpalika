import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  listPayoutAccounts,
  type PayoutAccountStatus,
} from "@/modules/bookings/payout-account.service";

export const runtime = "nodejs";

const STATUSES = new Set<PayoutAccountStatus>(["PENDING_REVIEW", "VERIFIED", "REJECTED"]);

/** Hostel payout accounts, masked, oldest first. `?status=PENDING_REVIEW` for the queue. */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    const params = request.nextUrl.searchParams;
    const status = params.get("status") as PayoutAccountStatus | null;
    const hostelId = params.get("hostelId");

    return withEtag(request, successResponse(
      {
        accounts: await listPayoutAccounts({
          ...(status && STATUSES.has(status) ? { status } : {}),
          ...(hostelId && /^[a-f0-9]{24}$/i.test(hostelId) ? { hostelId } : {}),
        }),
      },
      "Payout accounts",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
