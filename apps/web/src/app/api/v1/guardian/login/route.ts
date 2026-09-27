import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { recordFailedAttempt, refuseIfTooManyFailures } from "@/lib/auth-attempts";
import { shouldExposeRefreshToken } from "@/lib/mobile-auth";
import { applySessionCookies } from "@/lib/session-cookies";
import { loginGuardian } from "@/modules/guardian/guardian.service";
import { guardianLoginSchema } from "@/modules/guardian/guardian.validation";

export const runtime = "nodejs";

/**
 * Access-code sign-in for a guardian whose hostel handed them a code rather
 * than emailing an invitation.
 *
 * This route was written before `/auth/login` grew its protections and never
 * caught up. Three of them are here now, because a code-and-phone pair is a
 * *credential* and this is the only way to present it:
 *
 * **Rate limited, same 5-per-15-minutes as `/auth/login`.** The access code is
 * six characters and the phone number is not a secret — an unthrottled endpoint
 * is a guessing game whose prize is a session on somebody's guardian account,
 * and it was unthrottled until 2026-08-17. Wrong codes count, per phone and
 * address (`lib/auth-attempts.ts`); sign-ins that work do not.
 *
 * **The refresh token no longer goes to browsers.** It used to be returned in
 * the JSON body to every caller, which is what `/auth/login` deliberately avoids:
 * a refresh token readable by page scripts outlives an access-token rotation and
 * is the single most useful thing an XSS can steal. It is exposed only to the
 * mobile client, which has no cookie jar and no DOM.
 *
 * **Session cookies are set.** Without them a browser sign-in produced tokens
 * with nowhere to live, so the web has never been able to use this route at all.
 */
export async function POST(request: NextRequest) {
  try {
    const input = guardianLoginSchema.parse(await request.json());
    const limited = await refuseIfTooManyFailures(request, "guardian-login", input.phone);

    if (limited) {
      return limited;
    }

    const result = await loginGuardian(input).catch(async (error: unknown) => {
      if ((error as { errorCode?: string } | null)?.errorCode === "INVALID_GUARDIAN_LOGIN") {
        await recordFailedAttempt(request, "guardian-login", input.phone);
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
      "Guardian login successful",
    );

    return applySessionCookies(response, result);
  } catch (error) {
    return handleRouteError(error);
  }
}
