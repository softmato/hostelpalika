import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  createCategory,
  listCategoriesForAdmin,
} from "@/modules/store/store-admin.service";
import { storeCategoryCreateSchema } from "@/modules/store/store.validation";

export const runtime = "nodejs";

/**
 * Superadmin only, not PLATFORM_MODERATOR: what the platform sells and for how
 * much is a commercial decision, and a moderator moderates content
 * (`route-access.ts`, same rule as `/platform/sponsors`).
 */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    return withEtag(request, successResponse(await listCategoriesForAdmin(), "Categories loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const input = storeCategoryCreateSchema.parse(await request.json());

    return successResponse(await createCategory(input, principal), "Category created", {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
