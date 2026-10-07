import type { NextRequest } from "next/server";

import { ApiAuthError, loadApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  applyPinUnlockCookie,
  LOCK_PIN_UNLOCK_COOKIE,
  UNLOCK_IDLE_SECONDS,
} from "@/lib/lock-pin-cookie";

export const runtime = "nodejs";

/**
 * Someone is using the portal: the browser's PIN unlock gets another
 * {@link UNLOCK_IDLE_SECONDS}. Sent at most once a minute, on activity, by
 * `portal-account.tsx`. An unlock that already lapsed is not revived — that
 * answer (423) sends the tab to `/unlock`.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await loadApiPrincipal(request);

    if (!principal) {
      throw new ApiAuthError("Authentication is required.");
    }

    if (principal.pinLocked) {
      throw new ApiAuthError("Enter your PIN to continue.", "LOCK_PIN_REQUIRED", 423);
    }

    const response = successResponse({ idleSeconds: UNLOCK_IDLE_SECONDS }, "Still here");

    return request.cookies.get(LOCK_PIN_UNLOCK_COOKIE)
      ? applyPinUnlockCookie(response, principal.userId, principal.sessionId)
      : response;
  } catch (error) {
    return handleRouteError(error);
  }
}
