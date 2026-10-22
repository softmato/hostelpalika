import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { cachedRead } from "@/lib/redis-cache";
import { listAdminNightStatus } from "@/modules/safety/safety.service";
import { nightStatusListQuerySchema } from "@/modules/safety/safety.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewNightStatus");
    const query = nightStatusListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await cachedRead(principal, `night-status${request.nextUrl.search}`, () => listAdminNightStatus(query, principal));

    return withEtag(request, successResponse(result, "Night status loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
