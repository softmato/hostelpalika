import type { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { getBearerToken, readAccessTokenCookie, verifyAccessToken } from "@/lib/auth";
import { isPinUnlocked } from "@/lib/lock-pin-cookie";
import { AuthServiceError, getCurrentUser } from "@/modules/auth/auth.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const accessToken =
      getBearerToken(request.headers.get("authorization")) ??
      readAccessTokenCookie(request.cookies);

    if (!accessToken) {
      return errorResponse("Access token is missing.", "UNAUTHENTICATED", 401);
    }

    const user = await getCurrentUser(accessToken);

    /*
     * This browser still owes the app-lock PIN. A tab signed in before the PIN
     * was set on the phone carries a token without the claim, so `proxy.ts`
     * let its page through — the portal reads this and steps aside for
     * `/unlock` at once rather than on the next click. The app (bearer) draws
     * its own lock.
     */
    const pinLocked =
      !getBearerToken(request.headers.get("authorization")) &&
      user.hasLockPin &&
      !user.viaTemporaryCredential &&
      !(await isPinUnlocked(
        request.cookies,
        user.id,
        (await verifyAccessToken(accessToken)).sessionId,
      ));

    return successResponse({ user: { ...user, pinLocked } }, "Authenticated user loaded");
  } catch (error) {
    if (error instanceof AuthServiceError) {
      return errorResponse(error.message, error.errorCode, error.status);
    }

    return handleRouteError(error);
  }
}
