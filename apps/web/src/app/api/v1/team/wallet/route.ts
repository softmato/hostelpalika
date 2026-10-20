import type { NextRequest } from "next/server";

import { requireTeamPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getAgentWallet } from "@/modules/team/team-commission.service";

export const runtime = "nodejs";

/** The signed-in agent's commission wallet and today's figures. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireTeamPrincipal(request);

    return withEtag(request, successResponse(await getAgentWallet(principal.userId), "Wallet loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
