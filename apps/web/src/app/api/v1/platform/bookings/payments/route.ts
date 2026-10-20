import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listBookingPaymentsToCheck } from "@/modules/bookings/booking-review.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Booking screenshots waiting to be checked, oldest first. */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    return withEtag(request, successResponse({ payments: await listBookingPaymentsToCheck() }, "Payments to check"));
  } catch (error) {
    return handleRouteError(error);
  }
}
