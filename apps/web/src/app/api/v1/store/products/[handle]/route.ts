import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getStoreProduct } from "@/modules/store/catalog.service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ handle: string }> };

/** `handle` is an id or a slug - the phone pushes one, a shared link the other. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    await requireHostelAdminPrincipal(request);

    const { handle } = await context.params;

    return withEtag(request, successResponse(await getStoreProduct(handle), "Product loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
