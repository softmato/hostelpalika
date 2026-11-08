import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import {
  deactivateHostelWarden,
  updateHostelWarden,
} from "@/modules/wardens/warden.service";
import { wardenUpdateSchema } from "@/lib/wardens/warden.validation";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const { id } = await context.params;
    const input = wardenUpdateSchema.parse(await request.json());
    const result = await updateHostelWarden(id, input, principal);

    return successResponse(result, "Warden updated");
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const { id } = await context.params;
    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;
    const result = await deactivateHostelWarden(id, principal, hostelId);

    return successResponse(result, "Warden deactivated");
  } catch (error) {
    return handleRouteError(error);
  }
}
