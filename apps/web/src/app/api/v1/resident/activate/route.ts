import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { shouldExposeRefreshToken } from "@/lib/mobile-auth";
import { applySessionCookies } from "@/lib/session-cookies";
import { activateResident } from "@/modules/residents/activation.service";
import { activationCodeSchema } from "@/modules/residents/activation.validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    // An activation code is a guessable secret: throttled like a public form (P11-18).
    const limited = rateLimitPublicForm(request, { namespace: "resident-activate" });
    if (limited) return limited;

    const principal = await requireApiPrincipal(request);
    const input = activationCodeSchema.parse(await request.json());
    const result = await activateResident(input, principal);
    const response = successResponse(
      {
        activation: result.activation,
        accessToken: result.session.accessToken,
        ...(shouldExposeRefreshToken(request.headers)
          ? { refreshToken: result.session.refreshToken }
          : {}),
        resident: result.resident,
        user: result.session.user,
      },
      "Resident activated",
    );

    // Same session shape as every other sign-in path — see applySessionCookies.
    return applySessionCookies(response, result.session);
  } catch (error) {
    return handleRouteError(error);
  }
}
