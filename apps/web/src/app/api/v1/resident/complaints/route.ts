import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  createComplaint,
  listResidentComplaints,
} from "@/modules/complaints/complaint.service";
import { complaintCreateSchema } from "@/modules/complaints/complaint.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const result = await listResidentComplaints(principal);

    return withEtag(request, successResponse(result, "Complaints loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const input = complaintCreateSchema.parse(await request.json());
    const result = await createComplaint(input, principal);

    return successResponse(result, "Complaint submitted", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
