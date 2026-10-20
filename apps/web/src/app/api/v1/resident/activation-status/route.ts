import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getActivationStatus } from "@/modules/residents/activation.service";
import { activationStatusQuerySchema } from "@/modules/residents/activation.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const query = activationStatusQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await getActivationStatus(query, principal);

    return withEtag(request, successResponse(result, "Activation status loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
