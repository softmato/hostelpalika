import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listPlatformDirectory } from "@/modules/reports/platform-directory.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformPrincipal(request);
    const result = await listPlatformDirectory();

    return withEtag(request, successResponse(result, "Users loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
