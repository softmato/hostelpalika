import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { createSponsor, listSponsors } from "@/modules/sponsors/sponsor.service";
import {
  sponsorCreateSchema,
  sponsorListQuerySchema,
} from "@/modules/sponsors/sponsor.validation";

export const runtime = "nodejs";

/**
 * Superadmin only, not PLATFORM_MODERATOR: selling a placement is a commercial
 * decision, and a moderator moderates content (route-access.ts §platform).
 */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);
    const query = sponsorListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listSponsors(query);

    return withEtag(request, successResponse(result, "Sponsors loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const input = sponsorCreateSchema.parse(await request.json());
    const result = await createSponsor(input, principal);

    return successResponse(result, "Sponsor created", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
