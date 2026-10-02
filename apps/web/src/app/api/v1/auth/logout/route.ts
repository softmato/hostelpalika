import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { isMobileAuthClient, readBodyRefreshToken } from "@/lib/mobile-auth";
import { clearSessionCookies, readRefreshTokenCookie } from "@/lib/session-cookies";
import { logout } from "@/modules/auth/auth.service";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const mobile = isMobileAuthClient(request.headers);
    const cookieRefreshToken = mobile ? null : readRefreshTokenCookie(request);
    const bodyRefreshToken = cookieRefreshToken
      ? null
      : await readBodyRefreshToken(request);
    const refreshToken = cookieRefreshToken ?? bodyRefreshToken;

    if (refreshToken) {
      await logout(refreshToken);
    }

    const response = successResponse(null, "Logged out");
    return mobile ? response : clearSessionCookies(response);
  } catch (error) {
    return handleRouteError(error);
  }
}
