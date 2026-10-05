import type { NextRequest } from "next/server";
import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { billingHostelId } from "@/modules/billing/billing-hostel";
import { getBranchDetails } from "@/modules/hostels/hostel-branch.service";

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ branchId: string }> },
) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    if (!principal.hostelIds[0])
      throw Object.assign(new Error("Open a hostel first."), {
        status: 422,
        errorCode: "HOSTEL_SCOPE_REQUIRED",
      });
    const mainId = await billingHostelId(principal.hostelIds[0]);
    const { branchId } = await context.params;
    return successResponse(
      await getBranchDetails(mainId.toString(), branchId, principal),
      "Branch details loaded",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
