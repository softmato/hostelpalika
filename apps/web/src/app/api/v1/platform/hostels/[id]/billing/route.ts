import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getBillingHistory } from "@/modules/billing/billing-history.service";

type RouteContext = { params: Promise<{ id: string }> };

export const runtime = "nodejs";

/** One hostel's plan, invoices and payments to us — what its own billing screen shows. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await requirePlatformPrincipal(request);

    const { id } = await context.params;

    return withEtag(request, successResponse(await getBillingHistory(id), "Hostel billing loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
