import type { NextRequest } from "next/server";

import { assertPrimaryCredentialPrincipal, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { requestBiometricCode } from "@/modules/auth/auth.service";

export const runtime = "nodejs";

/**
 * Mails the signed-in account a code — the app's fingerprint-lock recovery.
 * Refused to a borrowed login: the code lands in the owner's inbox.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    assertPrimaryCredentialPrincipal(principal);

    const result = await requestBiometricCode(principal.userId, {
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
      userAgent: request.headers.get("user-agent") ?? undefined,
    });

    return successResponse(result, "Code sent");
  } catch (error) {
    return handleRouteError(error);
  }
}
