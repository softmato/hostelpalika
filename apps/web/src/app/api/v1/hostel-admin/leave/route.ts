import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  cancelLeaveRequest,
  getLeaveOverview,
  submitLeaveRequest,
} from "@/modules/hostels/hostel-leave.service";
import { hostelLeaveSubmitSchema } from "@/modules/hostels/hostel-leave.validation";

export const runtime = "nodejs";

/** Leaving the platform (docs/HOSTEL_LEAVE_PLATFORM.md): the bill check and any waiting request. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;

    return successResponse(await getLeaveOverview(principal, hostelId), "Leave status loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const input = hostelLeaveSubmitSchema.parse(await request.json());

    return successResponse({ request: await submitLeaveRequest(principal, input) }, "Request to leave sent");
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;

    return successResponse({ request: await cancelLeaveRequest(principal, hostelId) }, "Request cancelled");
  } catch (error) {
    return handleRouteError(error);
  }
}
