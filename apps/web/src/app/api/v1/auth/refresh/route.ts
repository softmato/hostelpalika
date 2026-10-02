import type { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { isMobileAuthClient, readBodyRefreshToken, shouldExposeRefreshToken } from "@/lib/mobile-auth";
import { applySessionCookies, clearSessionCookies, readRefreshTokenCookie } from "@/lib/session-cookies";
import { AuthServiceError, refreshAccessToken } from "@/modules/auth/auth.service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    // The PWA uses the mobile token contract but shares the website's origin.
    // Never replace its explicit session with an unrelated website cookie.
    const cookieRefreshToken = isMobileAuthClient(request.headers)
      ? null
      : readRefreshTokenCookie(request);
    const bodyRefreshToken = cookieRefreshToken
      ? null
      : await readBodyRefreshToken(request);
    const refreshToken = cookieRefreshToken ?? bodyRefreshToken;

    if (!refreshToken) {
      return errorResponse("Refresh token is missing.", "UNAUTHENTICATED", 401);
    }

    // Only a browser shares one cookie across concurrent refreshes; mobile
    // single-flights and must always get a rotated token back to store.
    const result = await refreshAccessToken(refreshToken, {
      cookieSession: Boolean(cookieRefreshToken),
    });
    const response = successResponse(
      {
        accessToken: result.accessToken,
        ...(shouldExposeRefreshToken(request.headers)
          ? { refreshToken: result.refreshToken }
          : {}),
        user: result.user,
      },
      "Token refreshed",
    );

    // Mobile passes the token in the body and stores the rotated one itself;
    // only a cookie-based session gets the rotated pair written back.
    if (cookieRefreshToken) {
      applySessionCookies(response, result);
    } else if (readRefreshTokenCookie(request) === bodyRefreshToken) {
      // Retire the duplicate cookie created by older app logins.
      clearSessionCookies(response);
    }

    return response;
  } catch (error) {
    if (error instanceof AuthServiceError) {
      return errorResponse(error.message, error.errorCode, error.status);
    }

    return handleRouteError(error);
  }
}
