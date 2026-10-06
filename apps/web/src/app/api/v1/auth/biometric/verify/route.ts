import type { NextRequest } from "next/server";

import { assertPrimaryCredentialPrincipal, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { verifyBiometricCode } from "@/modules/auth/auth.service";
import { otpVerifySchema } from "@/modules/auth/auth.validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    assertPrimaryCredentialPrincipal(principal);

    const input = otpVerifySchema.parse(await request.json());

    return successResponse(await verifyBiometricCode(principal.userId, input), "Code accepted");
  } catch (error) {
    return handleRouteError(error);
  }
}
