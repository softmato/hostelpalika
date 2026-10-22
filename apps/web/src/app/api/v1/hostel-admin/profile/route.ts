import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { cachedRead } from "@/lib/redis-cache";
import { requireHostelCapability, requireHostelStaffPrincipal } from "@/lib/api-auth";
import {
  getHostelAdminProfile,
  updateHostelAdminProfile,
} from "@/modules/hostels/hostel-profile.service";
import {
  hostelAdminProfileQuerySchema,
  hostelAdminProfileUpdateSchema,
} from "@/modules/hostels/hostel.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const query = hostelAdminProfileQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await cachedRead(principal, `profile${request.nextUrl.search}`, () =>
      getHostelAdminProfile(query, principal),
    );

    return withEtag(request, successResponse(result, "Hostel profile loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "editHostelProfile");
    const input = hostelAdminProfileUpdateSchema.parse(await request.json());
    const result = await updateHostelAdminProfile(input, principal);

    return successResponse(result, "Hostel profile updated");
  } catch (error) {
    return handleRouteError(error);
  }
}
