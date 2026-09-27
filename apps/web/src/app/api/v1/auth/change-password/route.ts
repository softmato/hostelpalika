import type { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { recordFailedAttempt, refuseIfTooManyFailures } from "@/lib/auth-attempts";
import { getBearerToken, readAccessTokenCookie, verifyAccessToken } from "@/lib/auth";
import { shouldExposeRefreshToken } from "@/lib/mobile-auth";
import { applySessionCookies } from "@/lib/session-cookies";
import { AuthServiceError, changePassword } from "@/modules/auth/auth.service";
import { changePasswordSchema } from "@hostel/shared/schemas/auth.schema";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const accessToken =
      getBearerToken(request.headers.get("authorization")) ??
      readAccessTokenCookie(request.cookies);

    if (!accessToken) {
      return errorResponse("Access token is missing.", "UNAUTHENTICATED", 401);
    }

    const payload = await verifyAccessToken(accessToken).catch(() => null);

    if (!payload?.sub) {
      return errorResponse("Access token is invalid.", "UNAUTHENTICATED", 401);
    }

    // A borrowed login must not be able to lock the owner out of their own
    // account — and `changePassword` revokes every session, so it would.
    if (payload.temporaryCredentialId) {
      return errorResponse(
        "A temporary login cannot change the account password.",
        "TEMPORARY_CREDENTIAL_FORBIDDEN",
        403,
      );
    }

    // The current password is checked here, so it is a guessing surface.
    const userId = payload.sub;
    const limited = await refuseIfTooManyFailures(request, "auth-change-password", userId);

    if (limited) {
      return limited;
    }

    const input = changePasswordSchema.parse(await request.json());
    const result = await changePassword(userId, input, {
      ipAddress: request.headers.get("x-forwarded-for")?.split(",")[0]?.trim(),
      userAgent: request.headers.get("user-agent") ?? undefined,
    }).catch(async (error: unknown) => {
      if (error instanceof AuthServiceError && error.errorCode === "INVALID_CREDENTIALS") {
        await recordFailedAttempt(request, "auth-change-password", userId);
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
      "Password changed",
    );

    return applySessionCookies(response, result);
  } catch (error) {
    if (error instanceof AuthServiceError) {
      return errorResponse(error.message, error.errorCode, error.status);
    }

    return handleRouteError(error);
  }
}
