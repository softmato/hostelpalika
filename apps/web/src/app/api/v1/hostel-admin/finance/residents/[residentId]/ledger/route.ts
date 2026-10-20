import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { getResidentLedger } from "@/modules/finance/resident-ledger.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ residentId: string }> };

/**
 * One resident's month-by-month payment history, from move-in to now.
 *
 * `viewPayments`, the same read capability as the matrix this is opened from —
 * it shows the same money, only sliced by resident instead of by month.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "viewPayments");
    const { residentId } = await context.params;
    const hostelId = resolveAdminHostelId(principal);
    const ledger = await getResidentLedger(hostelId, residentId);

    if (!ledger) {
      throw new FinanceServiceError("Resident not found.", "RESIDENT_NOT_FOUND");
    }

    return withEtag(request, successResponse(ledger, "Resident payment history"));
  } catch (error) {
    return handleRouteError(error);
  }
}
