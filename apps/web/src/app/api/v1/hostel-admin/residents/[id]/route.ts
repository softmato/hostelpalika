import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { requireHostelCapability, requireHostelStaffPrincipal } from "@/lib/api-auth";
import {
  deleteResident,
  getResidentById,
  updateResident,
} from "@/modules/residents/resident.service";
import {
  residentListQuerySchema,
  residentUpdateSchema,
} from "@/modules/residents/resident.validation";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const { id } = await context.params;
    const query = residentListQuerySchema
      .pick({ hostelId: true })
      .parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
    const result = await getResidentById(id, query, principal);

    return withEtag(request, successResponse(result, "Resident loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "registerResidents");
    const { id } = await context.params;
    const query = residentListQuerySchema
      .pick({ hostelId: true })
      .parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
    const result = await deleteResident(id, query, principal);

    return successResponse(result, "Resident removed");
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "registerResidents");
    const { id } = await context.params;
    const input = residentUpdateSchema.parse(await request.json());
    const result = await updateResident(id, input, principal);

    return successResponse(result, "Resident updated");
  } catch (error) {
    return handleRouteError(error);
  }
}
