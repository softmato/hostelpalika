import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { updateHostelAdminInquiryStatus } from "@/modules/hostels/hostel-inquiry.service";
import { hostelAdminInquiryStatusSchema } from "@/lib/hostels/hostel.validation";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const { id } = await context.params;
    const input = hostelAdminInquiryStatusSchema.parse(await request.json());
    const result = await updateHostelAdminInquiryStatus(id, input, principal);

    return successResponse(result, "Inquiry status updated");
  } catch (error) {
    return handleRouteError(error);
  }
}
