import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { reportExportResponse } from "@/modules/reports/report-response";
import { getStockReport, resolveStockActor, stockReportExport } from "@/modules/stock/stock.service";
import { stockReportQuerySchema } from "@/modules/stock/stock.validation";

export const runtime = "nodejs";

/** Per item bought / used / left and next month, over a range; `format=csv|pdf` downloads it. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageStock");
    const query = stockReportQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const report = await getStockReport(await resolveStockActor(principal, query.scope === "all"), query.range);

    if (query.format) return reportExportResponse(stockReportExport(report), { format: query.format, scopeName: report.scope });

    return withEtag(request, successResponse(report, "Report loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
