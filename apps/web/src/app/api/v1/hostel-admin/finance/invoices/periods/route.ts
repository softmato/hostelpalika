import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { cachedRead } from "@/lib/redis-cache";
import { getPeriodSummary } from "@/modules/finance/period-summary.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/**
 * Lifetime totals, a per-month roll-up, and the earliest month worth showing.
 *
 * `viewPayments`, the same read capability as the matrix it sits beside — it is
 * the same money, counted across every month instead of one.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewPayments");
    const hostelId = resolveAdminHostelId(principal);

    return withEtag(request, successResponse(await cachedRead(principal, "invoice-periods", () => getPeriodSummary(hostelId)), "Payment periods"));
  } catch (error) {
    return handleRouteError(error);
  }
}
