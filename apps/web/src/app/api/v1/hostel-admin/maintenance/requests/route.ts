import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { cachedRead } from "@/lib/redis-cache";
import {
  createMaintenanceRequest,
  listMaintenanceRequests,
} from "@/modules/maintenance/maintenance.service";
import {
  maintenanceRequestCreateSchema,
  maintenanceRequestListQuerySchema,
} from "@/modules/maintenance/maintenance.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageMaintenance");
    const query = maintenanceRequestListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await cachedRead(principal, `maintenance${request.nextUrl.search}`, () => listMaintenanceRequests(query, principal));

    return withEtag(request, successResponse(result, "Maintenance requests loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageMaintenance");
    const input = maintenanceRequestCreateSchema.parse(await request.json());
    const result = await createMaintenanceRequest(input, principal);

    return successResponse(result, "Maintenance request created", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
