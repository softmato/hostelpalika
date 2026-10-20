import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getResidentFinanceView } from "@/modules/finance/invoice-list.service";

export const runtime = "nodejs";

/**
 * The resident's invoices and their own claims (target §11.1, plan item 2.8).
 * Replaces `GET /api/v1/resident/payments`.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);

    return withEtag(request, successResponse(await getResidentFinanceView(principal), "Payments"));
  } catch (error) {
    return handleRouteError(error);
  }
}
