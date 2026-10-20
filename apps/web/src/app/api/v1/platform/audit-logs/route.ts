import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listPlatformAuditLogs } from "@/modules/audit/audit.service";
import { platformAuditLogQuerySchema } from "@/modules/audit/audit.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformPrincipal(request);
    const query = platformAuditLogQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listPlatformAuditLogs(query);

    return withEtag(request, successResponse(result, "Audit logs loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
