import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getCookPortalSettings, updateCookPortal } from "@/modules/food/cook.service";
import { cookPortalUpdateSchema } from "@/modules/food/cook.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageFood");
    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;
    const result = await getCookPortalSettings(principal, hostelId);

    return withEtag(request, successResponse(result, "Cook portal settings loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageFood");
    const input = cookPortalUpdateSchema.parse(await request.json());
    const result = await updateCookPortal(input, principal);

    return successResponse(
      result,
      input.enabled ? "Cook portal enabled" : "Cook portal disabled",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
