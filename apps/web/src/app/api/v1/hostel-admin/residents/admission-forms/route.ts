import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listAdmissionForms } from "@/modules/residents/admission-form.service";
import { hostelStaffScope } from "@/modules/residents/hostel-staff-scope";

export const runtime = "nodejs";

/** Forms filled through the hostel's Form QR, waiting for a bed. */
export async function GET(request: NextRequest) {
  try {
    const { hostelId } = await hostelStaffScope(request);

    return withEtag(request, successResponse(await listAdmissionForms(hostelId), "Forms loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
