import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getQuestionCallStatus } from "@/modules/questioncall/questioncall.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const result = await getQuestionCallStatus(principal);

    return withEtag(request, successResponse(result, "QuestionCall status loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
