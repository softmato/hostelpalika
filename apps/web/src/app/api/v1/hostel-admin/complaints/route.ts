import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { cachedRead } from "@/lib/redis-cache";
import { listAdminComplaints } from "@/modules/complaints/complaint.service";
import { complaintListQuerySchema } from "@/modules/complaints/complaint.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewComplaints");
    const query = complaintListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await cachedRead(principal, `complaints${request.nextUrl.search}`, () => listAdminComplaints(query, principal));

    return withEtag(request, successResponse(result, "Complaints loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
