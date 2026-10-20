import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getFoodRoutine, saveFoodRoutine } from "@/modules/food/food-routine.service";
import { resolveAdminHostelId } from "@/modules/food/food.service";
import { foodRoutineSaveSchema } from "@/modules/food/food.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageFood");
    const hostelId = resolveAdminHostelId(
      principal,
      request.nextUrl.searchParams.get("hostelId") ?? undefined,
    );
    const routine = await getFoodRoutine(hostelId);

    return withEtag(request, successResponse({ routine }, "Food routine loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/** The routine is one document, so a save is one replace — no per-cell writes. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageFood");
    const input = foodRoutineSaveSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);
    const result = await saveFoodRoutine(input, principal, hostelId);

    return successResponse(result, "Food routine saved");
  } catch (error) {
    return handleRouteError(error);
  }
}
