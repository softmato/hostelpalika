import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { uploadFoodPhoto } from "@/modules/food/food.service";
import { foodPhotoUploadSchema } from "@/lib/food/food.validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageFood");
    const input = foodPhotoUploadSchema.parse(await request.json());
    const result = await uploadFoodPhoto(input, principal);

    return successResponse(result, "Food photo uploaded", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
