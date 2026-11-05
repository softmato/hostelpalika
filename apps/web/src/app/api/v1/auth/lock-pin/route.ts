import type { NextRequest } from "next/server";

import { assertPrimaryCredentialPrincipal, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { recordFailedAttempt, refuseIfTooManyFailures } from "@/lib/auth-attempts";
import { applyPinUnlockCookie } from "@/lib/lock-pin-cookie";
import { AuthServiceError } from "@/modules/auth/auth.service";
import { lockPinProofSchema, setLockPinSchema } from "@/modules/auth/auth.validation";
import { removeLockPin, setLockPin } from "@/modules/auth/lock-pin.service";

export const runtime = "nodejs";

/**
 * A PIN change proved by the account password is a password guess, so it spends
 * the change-password failure budget (P11-16). Null when the run was refused.
 */
async function withPasswordBudget<T>(
  request: NextRequest,
  userId: string,
  password: string | undefined,
  run: () => Promise<T>,
) {
  if (password) {
    const limited = await refuseIfTooManyFailures(request, "auth-change-password", userId);

    if (limited) {
      return { limited };
    }
  }

  return {
    result: await run().catch(async (error: unknown) => {
      if (password && error instanceof AuthServiceError && error.errorCode === "INVALID_CREDENTIALS") {
        await recordFailedAttempt(request, "auth-change-password", userId);
      }

      throw error;
    }),
  };
}

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
    const out = await withPasswordBudget(request, principal.userId, input.password, () =>
      setLockPin(principal.userId, input),
    );

    if ("limited" in out) {
      return out.limited;
    }

    const response = successResponse(out.result, "PIN saved");

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

    const out = await withPasswordBudget(request, principal.userId, proof.password, () =>
      removeLockPin(principal.userId, proof),
    );

    return "limited" in out ? out.limited : successResponse(out.result, "App lock is off");
  } catch (error) {
    return handleRouteError(error);
  }
}
