import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getMyJoinRequest } from "@/modules/residents/my-join-request";

export const runtime = "nodejs";

/**
 * The signed-in account's own open join request — waiting or sent back — with
 * the link to reopen it. Scoped to the caller's `userId`; `{ request: null }`
 * is the normal answer.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);

    return successResponse(await getMyJoinRequest(principal.userId), "Join request loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}
