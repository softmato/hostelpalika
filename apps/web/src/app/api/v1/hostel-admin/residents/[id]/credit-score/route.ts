import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getResidentCreditScore } from "@/modules/finance/credit-score.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/** One resident's credit score, for the hostel's admin or warden. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "viewPayments");
    const { id } = await context.params;
    const hostelId = resolveAdminHostelId(principal, request.nextUrl.searchParams.get("hostelId") ?? undefined);

    return withEtag(request, successResponse(await getResidentCreditScore(hostelId, id), "Credit score"));
  } catch (error) {
    return handleRouteError(error);
  }
}
