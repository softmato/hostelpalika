import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { addLeave, leaveAddSchema, listLeaves } from "@/modules/finance/resident-leave.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/** A resident's days away and the hostel's rule for them. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "viewPayments");
    const { id } = await context.params;
    const hostelId = resolveAdminHostelId(principal, request.nextUrl.searchParams.get("hostelId") ?? undefined);

    return successResponse(await listLeaves(hostelId, id), "Days away");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Days away take money off a bill, so they are a cash decision. */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelCapability(request, "recordCash");
    const { id } = await context.params;
    const input = leaveAddSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(await addLeave(hostelId, id, input, principal), "Saved", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
