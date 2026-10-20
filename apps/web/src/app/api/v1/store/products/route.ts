import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listStoreProducts } from "@/modules/store/catalog.service";
import { storeProductListQuerySchema } from "@/modules/store/store.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireHostelAdminPrincipal(request);

    const query = storeProductListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );

    return withEtag(request, successResponse(await listStoreProducts(query), "Products loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
