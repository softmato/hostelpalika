import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { ArrivalError, announceArrival, arrivalSchema } from "@/modules/arrivals/arrival.service";

type RouteContext = { params: Promise<{ slug: string }> };

export const runtime = "nodejs";

/** Tells the hostel's staff when a signed-in traveller will arrive. No position is sent. */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const rateLimited = rateLimitPublicForm(request, { namespace: "hostel-arriving" });

    if (rateLimited) {
      return rateLimited;
    }

    const principal = await requireApiPrincipal(request);
    const { slug } = await context.params;
    const input = arrivalSchema.parse(await request.json());

    return successResponse(await announceArrival(slug, input, principal), "Hostel told");
  } catch (error) {
    if (error instanceof ArrivalError) {
      return errorResponse(error.message, error.code, error.statusCode);
    }

    return handleRouteError(error);
  }
}
