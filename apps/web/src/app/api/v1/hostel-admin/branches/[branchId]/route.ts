import type { NextRequest } from "next/server";
import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { billingHostelId } from "@/modules/billing/billing-hostel";
import { z } from "zod";
import { getBranchDetails, setBranchLabel } from "@/modules/hostels/hostel-branch.service";

export async function PATCH(
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
    const { branchLabel } = z
      .object({ branchLabel: z.string().trim().min(1).max(40) })
      .parse(await request.json());
    return successResponse(
      await setBranchLabel(mainId.toString(), branchId, branchLabel, principal),
      "Branch label saved",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}

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
    return withEtag(request, successResponse(
      await getBranchDetails(mainId.toString(), branchId, principal),
      "Branch details loaded",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
