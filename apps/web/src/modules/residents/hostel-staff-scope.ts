import { Types } from "mongoose";
import type { NextRequest } from "next/server";

import { assertHostelScopedApiAccess, requireHostelCapability } from "@/lib/api-auth";

/**
 * Staff with `registerResidents`, for their one hostel or the `?hostelId=`
 * asked for. Its own file so a route can use it without importing the
 * existing-residents module and the spreadsheet library behind it.
 */
export async function hostelStaffScope(request: NextRequest) {
  const principal = await requireHostelCapability(request, "registerResidents");
  const requested = request.nextUrl.searchParams.get("hostelId");

  if (requested) {
    assertHostelScopedApiAccess(principal, requested);

    return { hostelId: new Types.ObjectId(requested), principal };
  }

  if (principal.hostelIds.length === 1) {
    return { hostelId: new Types.ObjectId(principal.hostelIds[0]), principal };
  }

  throw Object.assign(new Error("A hostelId is required for this action."), {
    errorCode: "HOSTEL_SCOPE_REQUIRED",
    status: 422,
  });
}
