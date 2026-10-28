import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { cachedRead } from "@/lib/redis-cache";
import { getStockUsage, resolveStockActor } from "@/modules/stock/stock.service";
import { stockUsageQuerySchema } from "@/modules/stock/stock.validation";

export const runtime = "nodejs";

/** How much was used — today, this week, this month — per item, day and building, and how much the kitchen entered. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageStock");
    const query = stockUsageQuerySchema.parse(Object.fromEntries(request.nextUrl.searchParams));

    const load = async () => getStockUsage(await resolveStockActor(principal, query.scope === "all"), query.range);
    const usage = query.scope === "all" ? await load() : await cachedRead(principal, `stock-usage${request.nextUrl.search}`, load);

    return withEtag(request, successResponse(usage, "Usage loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
