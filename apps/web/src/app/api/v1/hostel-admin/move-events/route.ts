import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listMoveEvents } from "@/modules/move-checklist/move-checklist.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "registerResidents");
    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;
    const result = await listMoveEvents(principal, hostelId);

    return withEtag(request, successResponse(result, "Move events loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
