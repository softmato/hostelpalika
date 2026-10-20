import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { findResidencyInvite } from "@/modules/residents/residency-invite.service";

export const runtime = "nodejs";

/** "Your hostel added you as a resident" — or `invite: null`. See the service. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);

    return withEtag(request, successResponse({ invite: await findResidencyInvite(principal) }, "Invite loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
