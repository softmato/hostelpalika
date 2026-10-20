import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getResidentNightStatusHistory } from "@/modules/safety/safety.service";

export const runtime = "nodejs";

/** The signed-in resident's own night-by-night record, newest first. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);

    return withEtag(request, successResponse(
      await getResidentNightStatusHistory(principal),
      "Night status history loaded",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
