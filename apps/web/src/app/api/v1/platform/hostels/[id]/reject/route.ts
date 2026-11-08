import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { requirePlatformPrincipal } from "@/lib/api-auth";
import { rejectPlatformHostel } from "@/modules/hostels/hostel.service";
import { hostelRejectSchema } from "@/lib/hostels/hostel.validation";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requirePlatformPrincipal(request);
    const { id } = await context.params;
    const input = hostelRejectSchema.parse(await request.json());
    const result = await rejectPlatformHostel(id, input, principal);

    return successResponse(result, "Hostel rejected");
  } catch (error) {
    return handleRouteError(error);
  }
}
