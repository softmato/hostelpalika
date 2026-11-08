import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { requirePlatformPrincipal } from "@/lib/api-auth";
import { unpublishPlatformHostel } from "@/modules/hostels/hostel.service";
import { hostelUnpublishSchema } from "@/lib/hostels/hostel.validation";

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
    const input = hostelUnpublishSchema.parse(await request.json());
    const result = await unpublishPlatformHostel(id, input, principal);

    return successResponse(
      result,
      result.notification.sent
        ? "Hostel unpublished"
        : "Hostel unpublished, but the owner could not be emailed",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
