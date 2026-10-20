import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getSiteConfig } from "@/modules/platform-config/site-config.service";

export const runtime = "nodejs";

/**
 * Superadmin-only: a PLATFORM_MODERATOR moderates content but must not reach
 * platform configuration (PHASES.md §5.1). The public site reads its own copy
 * of this config through the site-config provider, not this endpoint.
 */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);
    const config = await getSiteConfig();

    return withEtag(request, successResponse({ config }, "Site configuration loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
