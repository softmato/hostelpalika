import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { setUserBlocked } from "@/modules/users/platform-admin.service";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

/** Blocks the account: signed out everywhere, every sign-in refused. */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const { id } = await context.params;

    return successResponse(await setUserBlocked(id, true, principal), "User blocked");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Lifts a block. */
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const { id } = await context.params;

    return successResponse(await setUserBlocked(id, false, principal), "User unblocked");
  } catch (error) {
    return handleRouteError(error);
  }
}
