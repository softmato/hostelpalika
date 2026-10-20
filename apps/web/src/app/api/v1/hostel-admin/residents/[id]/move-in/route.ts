import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  createMoveInChecklist,
  getMoveInChecklist,
} from "@/modules/move-checklist/move-checklist.service";
import { moveInChecklistSchema } from "@/modules/move-checklist/move-checklist.validation";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "registerResidents");
    const { id } = await context.params;
    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;
    const result = await getMoveInChecklist(id, principal, hostelId);

    return withEtag(request, successResponse(result, "Move-in checklist loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "registerResidents");
    const { id } = await context.params;
    const input = moveInChecklistSchema.parse(await request.json());
    const result = await createMoveInChecklist(id, input, principal);

    return successResponse(result, "Move-in checklist saved", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
