import type { NextRequest } from "next/server";

import { requireTeamPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getOperationsConfig } from "@/modules/platform-config/operations-config";

export const runtime = "nodejs";

/**
 * The setup fee an agent collects at registration — the form's default and its
 * ceiling. The registration refuses more than this either way.
 */
export async function GET(request: NextRequest) {
  try {
    await requireTeamPrincipal(request);

    const { teamSetupFee } = await getOperationsConfig();

    return successResponse({ setupFee: teamSetupFee }, "Setup fee loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}
