import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { declineAdmissionForm, getAdmissionForm } from "@/modules/residents/admission-form.service";
import { hostelStaffScope } from "@/modules/residents/hostel-staff-scope";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ formId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { hostelId } = await hostelStaffScope(request);
    const { formId } = await context.params;

    return successResponse(await getAdmissionForm(hostelId, formId), "Form loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Not taking them — the form leaves the list. Registering them is the normal intake, with `admissionFormId`. */
export async function DELETE(request: NextRequest, context: RouteContext) {
  try {
    const { hostelId, principal } = await hostelStaffScope(request);
    const { formId } = await context.params;

    return successResponse(await declineAdmissionForm(hostelId, formId, principal), "Form declined");
  } catch (error) {
    return handleRouteError(error);
  }
}
