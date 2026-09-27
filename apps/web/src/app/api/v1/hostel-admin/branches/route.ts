import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { billingHostelId } from "@/modules/billing/billing-hostel";
import {
  branchRequestSchema,
  listBranches,
  requestBranch,
} from "@/modules/hostels/hostel-branch.service";

export const runtime = "nodejs";

/** The main hostel of whichever hostel the owner is working in — a branch answers for its main one. */
async function mainHostelOf(hostelId: string | undefined) {
  if (!hostelId) {
    throw Object.assign(new Error("Open a hostel first."), { errorCode: "HOSTEL_SCOPE_REQUIRED", status: 422 });
  }

  return (await billingHostelId(hostelId)).toString();
}

/** The main hostel's branches and how many more its plan allows. Owner only. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);

    return successResponse(
      await listBranches(await mainHostelOf(principal.hostelIds[0]), principal),
      "Branches loaded",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Files a branch for a superadmin to call and approve. Owner only. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const input = branchRequestSchema.parse(await request.json());

    return successResponse(
      await requestBranch(await mainHostelOf(principal.hostelIds[0]), input, principal),
      "Branch sent for approval",
      { status: 201 },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
