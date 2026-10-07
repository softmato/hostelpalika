import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { exchangeQuestionCallSsoCode } from "@/modules/questioncall/questioncall.service";
import { questionCallSsoExchangeSchema } from "@/modules/questioncall/questioncall.validation";

import { questionCallSecretError } from "../questioncall-secret";

export const runtime = "nodejs";

/**
 * QuestionCall's backend trades the single-use code a resident arrived with
 * (`?hp_code=`) for that resident's verified identity, then signs them in on
 * its side. Server to server only: the shared secret never reaches a phone.
 */
export async function POST(request: NextRequest) {
  try {
    const denied = questionCallSecretError(request);

    if (denied) {
      return denied;
    }

    const input = questionCallSsoExchangeSchema.parse(await request.json());
    const result = await exchangeQuestionCallSsoCode(input);

    return successResponse(result, "QuestionCall sign-in exchanged");
  } catch (error) {
    return handleRouteError(error);
  }
}
