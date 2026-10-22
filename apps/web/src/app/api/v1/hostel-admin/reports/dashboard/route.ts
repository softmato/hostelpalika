import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { cachedRead } from "@/lib/redis-cache";
import { getHostelAdminDashboardReport } from "@/modules/reports/report.service";
import { reportQuerySchema } from "@/modules/reports/report.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const query = reportQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await cachedRead(principal, `dashboard${request.nextUrl.search}`, () =>
      getHostelAdminDashboardReport(query, principal),
    );

    return withEtag(request, successResponse(result, "Hostel report loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
