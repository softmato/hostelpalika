import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { recordQuestionCallConversion } from "@/modules/questioncall/questioncall.service";
import { questionCallConversionSchema } from "@/modules/questioncall/questioncall.validation";

import { questionCallSecretError } from "../questioncall-secret";

export const runtime = "nodejs";

/**
 * QuestionCall calls this once a referred student completes signup, which is
 * the only way `converted` is ever set — the platform does not guess.
 */
export async function POST(request: NextRequest) {
  try {
    const denied = questionCallSecretError(request);

    if (denied) {
      return denied;
    }

    const input = questionCallConversionSchema.parse(await request.json());
    const result = await recordQuestionCallConversion(input);

    return successResponse(result, "QuestionCall conversion recorded");
  } catch (error) {
    return handleRouteError(error);
  }
}
