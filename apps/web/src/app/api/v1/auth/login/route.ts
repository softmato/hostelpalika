import type { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { recordFailedAttempt, refuseIfTooManyFailures } from "@/lib/auth-attempts";
import { shouldExposeRefreshToken } from "@/lib/mobile-auth";
import { applySessionCookies } from "@/lib/session-cookies";
import { AuthServiceError, login } from "@/modules/auth/auth.service";
import { loginSchema } from "@/modules/auth/auth.validation";

export const runtime = "nodejs";

/**
 * PHASES.md §1.1 security deliverable: five wrong passwords per account per
 * address per 15 minutes (`lib/auth-attempts.ts`). Only failures count, so a
 * hostel full of residents signing in on one Wi-Fi never trips it.
 */
export async function POST(request: NextRequest) {
  try {
    const input = loginSchema.parse(await request.json());
    const limited = await refuseIfTooManyFailures(request, "auth-login", input.identifier);

    if (limited) {
      return limited;
    }

    const result = await login(input, {
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
      userAgent: request.headers.get("user-agent") ?? undefined,
    }).catch(async (error: unknown) => {
      if (error instanceof AuthServiceError && error.errorCode === "INVALID_CREDENTIALS") {
        await recordFailedAttempt(request, "auth-login", input.identifier);
      }

      throw error;
    });
    const response = successResponse(
      {
        accessToken: result.accessToken,
        ...(shouldExposeRefreshToken(request.headers)
          ? { refreshToken: result.refreshToken }
          : {}),
        user: result.user,
      },
      "Login successful",
    );

    return shouldExposeRefreshToken(request.headers) ? response : applySessionCookies(response, result);
  } catch (error) {
    if (error instanceof AuthServiceError) {
      return errorResponse(error.message, error.errorCode, error.status);
    }

    return handleRouteError(error);
  }
}
