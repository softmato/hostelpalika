import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { updateHostelOwnerEmail } from "@/modules/hostels/hostel.service";
import { hostelOwnerEmailSchema } from "@/modules/hostels/hostel.validation";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

/** Superadmin fixes the owner email a registration was filed with. */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const { id } = await context.params;
    const input = hostelOwnerEmailSchema.parse(await request.json());
    const result = await updateHostelOwnerEmail(id, input.email, principal);

    return successResponse(result, result.changed ? "Owner email updated" : "Owner email unchanged");
  } catch (error) {
    return handleRouteError(error);
  }
}
