import type { NextRequest } from "next/server";

import { loadApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import {
  admissionFormInputSchema,
  getAdmissionFormPage,
  submitAdmissionForm,
} from "@/modules/residents/admission-form.service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ token: string }> };

/** A hostel's Form QR, as the person filling it sees it: the hostel's name, and whether it is open. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const limited = rateLimitPublicForm(request, { limit: 60, namespace: "admission-form-read" });

    if (limited) return limited;

    const { token } = await context.params;

    return withEtag(request, successResponse(await getAdmissionFormPage(token), "Form loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Send the form. No account needed — it is the paper form, on their phone. */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const limited = rateLimitPublicForm(request, { limit: 8, namespace: "admission-form-send" });

    if (limited) return limited;

    const { token } = await context.params;
    const principal = await loadApiPrincipal(request);
    const input = admissionFormInputSchema.parse(await request.json());

    return successResponse(
      await submitAdmissionForm(token, input, principal?.userId ?? null),
      "Form sent",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
