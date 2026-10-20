import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getHostelPerformanceReport } from "@/modules/reports/performance-report.service";
import { performanceReportQuerySchema } from "@/modules/reports/report.validation";

export const runtime = "nodejs";

/** The month on one page — the Reports screen reads this, the PDF prints it. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const query = performanceReportQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const report = await getHostelPerformanceReport(query, principal);

    return withEtag(request, successResponse({ report }, "Performance report loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
