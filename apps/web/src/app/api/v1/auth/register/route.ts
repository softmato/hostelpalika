import type { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitAuthAttempts } from "@/lib/rate-limit";
import { shouldExposeRefreshToken } from "@/lib/mobile-auth";
import { applySessionCookies } from "@/lib/session-cookies";
import { AuthServiceError, registerPublicAccount } from "@/modules/auth/auth.service";
import { registerSchema } from "@/modules/auth/auth.validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    // Registration sends mail; unbounded, it is a spam amplifier.
    const limited = rateLimitAuthAttempts(request, "auth-register");

    if (limited) {
      return limited;
    }

    const input = registerSchema.parse(await request.json());
    const result = await registerPublicAccount(input, {
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
      "Registration successful",
      { status: 201 },
    );

    // Was hand-rolled here, and wrote the refresh cookie to "/api/v1/auth"
    // while every other sign-in path wrote it to "/api" — two shapes of session
    // depending on which door you came through. One helper now.
    return shouldExposeRefreshToken(request.headers) ? response : applySessionCookies(response, result);
  } catch (error) {
    if (error instanceof AuthServiceError) {
      return errorResponse(error.message, error.errorCode, error.status);
    }

    return handleRouteError(error);
  }
}
