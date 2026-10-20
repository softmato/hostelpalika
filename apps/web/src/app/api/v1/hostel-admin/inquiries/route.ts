import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { listHostelAdminInquiries } from "@/modules/hostels/hostel-inquiry.service";
import { hostelAdminInquiryListQuerySchema } from "@/modules/hostels/hostel.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const query = hostelAdminInquiryListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listHostelAdminInquiries(query, principal);

    return withEtag(request, successResponse(result, "Inquiries loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
