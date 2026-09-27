import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  getShortStaySettings,
  saveShortStaySettings,
} from "@/modules/bookings/short-stay-settings.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/** Whether this hostel takes short stays, its minimum nights and daily rates, with each room's floor. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const hostelId = resolveAdminHostelId(principal, request.nextUrl.searchParams.get("hostelId") ?? undefined);

    return successResponse(await getShortStaySettings(hostelId), "Short stays");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Saves them. A daily rate below its room's floor is refused. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const body = (await request.json()) as Record<string, unknown>;
    const hostelId = resolveAdminHostelId(principal, typeof body.hostelId === "string" ? body.hostelId : undefined);

    return successResponse(await saveShortStaySettings(hostelId, body, principal.userId), "Short stays saved");
  } catch (error) {
    return handleRouteError(error);
  }
}
