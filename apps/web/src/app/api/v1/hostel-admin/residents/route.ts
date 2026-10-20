import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { requireHostelCapability, requireHostelStaffPrincipal } from "@/lib/api-auth";
import { createResident, listResidents } from "@/modules/residents/resident.service";
import {
  residentCreateSchema,
  residentListQuerySchema,
} from "@/modules/residents/resident.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const query = residentListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listResidents(query, principal);

    return withEtag(request, successResponse(result, "Residents loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "registerResidents");
    const input = residentCreateSchema.parse(await request.json());
    const result = await createResident(input, principal);

    return successResponse(result, "Resident created", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
