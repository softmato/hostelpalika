import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { requireHostelCapability } from "@/lib/api-auth";
import { listResidentContacts } from "@/modules/residents/resident.service";
import { residentListQuerySchema } from "@/modules/residents/resident.validation";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

/**
 * Guardians and emergency contacts on file for one resident. Registering from a
 * resident ID writes both, so the admin panel shows them instead of a blank form.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "registerResidents");
    const { id } = await context.params;
    const query = residentListQuerySchema
      .pick({ hostelId: true })
      .parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
    const result = await listResidentContacts(id, query, principal);

    return withEtag(request, successResponse(result, "Resident contacts loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
