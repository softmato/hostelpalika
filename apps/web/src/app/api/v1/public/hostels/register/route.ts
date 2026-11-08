import type { NextRequest } from "next/server";

import { loadApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { registerPublicHostelApplication } from "@/modules/hostels/hostel.service";
import { hostelRegistrationSchema } from "@/lib/hostels/hostel-registration.validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const rateLimited = rateLimitPublicForm(request, {
      namespace: "public-hostel-registration",
    });

    if (rateLimited) {
      return rateLimited;
    }

    // The registration form is behind an auth guard, so tie the application to
    // the signed-in account when present. This lets the owner see their
    // submission status on return, regardless of the contact details they typed.
    const principal = await loadApiPrincipal(request);
    const input = hostelRegistrationSchema.parse(await request.json());
    const result = await registerPublicHostelApplication(input, {
      authUserId: principal?.userId,
    });

    return successResponse(result, "Hostel registration submitted", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
