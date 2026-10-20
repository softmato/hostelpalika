import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { createHostelWarden, listHostelWardens } from "@/modules/wardens/warden.service";
import {
  wardenCreateSchema,
  wardenListQuerySchema,
} from "@/modules/wardens/warden.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const query = wardenListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listHostelWardens(query, principal);

    return withEtag(request, successResponse(result, "Wardens loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const input = wardenCreateSchema.parse(await request.json());
    const result = await createHostelWarden(input, principal);

    return successResponse(result, "Warden saved");
  } catch (error) {
    return handleRouteError(error);
  }
}
