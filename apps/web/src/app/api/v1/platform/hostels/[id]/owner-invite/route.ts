import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { sendHostelOwnerInvite } from "@/modules/hostels/hostel.service";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

/** Re-sends the owner's portal login to the email now on file. */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const { id } = await context.params;
    const result = await sendHostelOwnerInvite(id, principal);

    return successResponse(result, "Owner invite sent");
  } catch (error) {
    return handleRouteError(error);
  }
}
