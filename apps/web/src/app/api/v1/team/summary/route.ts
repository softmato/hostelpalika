import type { NextRequest } from "next/server";

import { requireTeamPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getAgentSummary } from "@/modules/team/team.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireTeamPrincipal(request);
    const result = await getAgentSummary(principal.userId);

    return withEtag(request, successResponse(result, "Summary loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
