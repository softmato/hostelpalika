import { NextResponse, type NextRequest } from "next/server";

import { handleRouteError } from "@/lib/api-response";
import { readAdmissionFormPhoto } from "@/modules/residents/admission-form.service";
import { hostelStaffScope } from "@/modules/residents/hostel-staff-scope";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ formId: string }> };

/** The photo on an admission form, streamed for the hostel's staff. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const { hostelId } = await hostelStaffScope(request);
    const { formId } = await context.params;
    const photo = await readAdmissionFormPhoto(hostelId, formId);

    return new NextResponse(photo.body, {
      headers: {
        "Cache-Control": "private, max-age=3600",
        "Content-Type": photo.contentType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
