import type { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { shouldExposeRefreshToken } from "@/lib/mobile-auth";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { applySessionCookies } from "@/lib/session-cookies";
import { AuthServiceError, authenticateWithGoogle } from "@/modules/auth/auth.service";
import { googleAuthSchema } from "@/modules/auth/auth.validation";

export const runtime = "nodejs";

/**
 * Google sign-in via Google Identity Services: the client obtains an ID token
 * and posts it here; the server verifies it against Google's JWKS
 * (ARCHITECTURE.md §3.1 — token verified server-side).
 */
export async function POST(request: NextRequest) {
  try {
    const limited = rateLimitPublicForm(request, {
      limit: 10,
      namespace: "auth-google",
      windowMs: 15 * 60 * 1000,
    });

    if (limited) {
      return limited;
    }

    const input = googleAuthSchema.parse(await request.json());
    const result = await authenticateWithGoogle(input, {
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
      userAgent: request.headers.get("user-agent") ?? undefined,
    });
    const response = successResponse(
      {
        accessToken: result.accessToken,
        ...(shouldExposeRefreshToken(request.headers)
          ? { refreshToken: result.refreshToken }
          : {}),
        user: result.user,
      },
      "Google sign-in successful",
    );

    return shouldExposeRefreshToken(request.headers) ? response : applySessionCookies(response, result);
  } catch (error) {
    if (error instanceof AuthServiceError) {
      return errorResponse(error.message, error.errorCode, error.status);
    }

    return handleRouteError(error);
  }
}
