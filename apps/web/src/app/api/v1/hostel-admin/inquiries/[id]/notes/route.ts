import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { addHostelAdminInquiryNote } from "@/modules/hostels/hostel-inquiry.service";
import { inquiryNoteCreateSchema } from "@/lib/hostels/hostel.validation";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const { id } = await context.params;
    const input = inquiryNoteCreateSchema.parse(await request.json());
    const result = await addHostelAdminInquiryNote(id, input, principal);

    return successResponse(result, "Inquiry note added", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
