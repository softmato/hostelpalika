import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  createExpertConsultationRequest,
  getMyExpertConsultationRequest,
} from "@/modules/expert-consultation/expert-consultation.service";
import { expertConsultationCreateSchema } from "@/modules/expert-consultation/expert-consultation.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const result = await getMyExpertConsultationRequest(principal.userId);

    return withEtag(request, successResponse(result, "Consultation request loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const input = expertConsultationCreateSchema.parse(await request.json());
    const result = await createExpertConsultationRequest(principal.userId, input);

    return successResponse(result, "Request sent — our team will call you soon.");
  } catch (error) {
    return handleRouteError(error);
  }
}
