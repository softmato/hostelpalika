import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getPlatformPaymentsOverview, getRecentPlatformPayments } from "@/modules/reports/report.service";
import { paginationQuerySchema } from "@/lib/pagination";
import { z } from "zod";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformPrincipal(request);
    const params = request.nextUrl.searchParams;
    const result = params.get("view") === "recent"
      ? await getRecentPlatformPayments(z.object(paginationQuerySchema).parse(Object.fromEntries(params)))
      : await getPlatformPaymentsOverview();

    return successResponse(result, "Platform payments loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}
