import type { NextRequest } from "next/server";

import { assertPrimaryCredentialPrincipal, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { applyPinUnlockCookie } from "@/lib/lock-pin-cookie";
import { lockPinProofSchema, setLockPinSchema } from "@/modules/auth/auth.validation";
import { removeLockPin, setLockPin } from "@/modules/auth/lock-pin.service";

export const runtime = "nodejs";

/**
 * Sets the account's app-lock PIN, or replaces it (current PIN, or an email
 * code when it is forgotten). Refused to a borrowed login: the PIN is the
 * owner's. Whoever just set it has proved themselves, so a web session is
 * unlocked on the spot.
 */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    assertPrimaryCredentialPrincipal(principal);

    const input = setLockPinSchema.parse(await request.json());
    const response = successResponse(await setLockPin(principal.userId, input), "PIN saved");

    return applyPinUnlockCookie(response, principal.userId, principal.sessionId);
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Turns the lock off on every phone and the website. */
export async function DELETE(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    assertPrimaryCredentialPrincipal(principal);

    const proof = lockPinProofSchema.parse(await request.json());

    return successResponse(await removeLockPin(principal.userId, proof), "App lock is off");
  } catch (error) {
    return handleRouteError(error);
  }
}
