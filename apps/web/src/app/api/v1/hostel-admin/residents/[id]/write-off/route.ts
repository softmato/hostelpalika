import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { writeOffResidentDues } from "@/modules/move-checklist/move-checklist.service";
import { writeOffSchema } from "@/modules/move-checklist/move-checklist.validation";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/** Let go of what a moved-out resident still owes — it leaves every total. */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "recordCash");
    const { id } = await context.params;
    const input = writeOffSchema.parse(await request.json().catch(() => ({})));

    return successResponse(await writeOffResidentDues(id, input, principal), "Written off");
  } catch (error) {
    return handleRouteError(error);
  }
}
