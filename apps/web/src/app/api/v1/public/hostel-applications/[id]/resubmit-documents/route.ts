import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { requireApiPrincipal } from "@/lib/api-auth";
import { resubmitOwnerHostelDocuments } from "@/modules/hostels/hostel.service";
import { hostelResubmitDocumentsSchema } from "@/lib/hostels/hostel.validation";

type RouteContext = {
  params: Promise<{
    id: string;
  }>;
};

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireApiPrincipal(request);
    const { id } = await context.params;
    const input = hostelResubmitDocumentsSchema.parse(await request.json());
    const result = await resubmitOwnerHostelDocuments(principal.userId, id, input);

    return successResponse(result, "Documents resubmitted");
  } catch (error) {
    return handleRouteError(error);
  }
}
