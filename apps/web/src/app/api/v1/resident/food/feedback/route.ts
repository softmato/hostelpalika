import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { submitFoodFeedback } from "@/modules/food/food.service";
import { foodFeedbackSchema } from "@/lib/food/food.validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const input = foodFeedbackSchema.parse(await request.json());
    const result = await submitFoodFeedback(input, principal);

    return successResponse(result, "Food feedback submitted", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
