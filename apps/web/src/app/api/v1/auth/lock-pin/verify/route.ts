import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { applyPinUnlockCookie } from "@/lib/lock-pin-cookie";
import { verifyLockPinSchema } from "@/modules/auth/auth.validation";
import { verifyLockPin } from "@/modules/auth/lock-pin.service";

export const runtime = "nodejs";

/** The unlock: the app checks the PIN here, and the website gets its unlock cookie. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const { pin } = verifyLockPinSchema.parse(await request.json());
    const response = successResponse(await verifyLockPin(principal.userId, pin), "Unlocked");

    return applyPinUnlockCookie(response, principal.userId, principal.sessionId);
  } catch (error) {
    return handleRouteError(error);
  }
}
