import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { createProduct, listProductsForAdmin } from "@/modules/store/store-admin.service";
import {
  storeProductCreateSchema,
  storeProductListQuerySchema,
} from "@/modules/store/store.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    const query = storeProductListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );

    return withEtag(request, successResponse(await listProductsForAdmin(query), "Products loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const input = storeProductCreateSchema.parse(await request.json());

    return successResponse(await createProduct(input, principal), "Product created", {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
