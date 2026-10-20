import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { checkResidentEmail } from "@/modules/users/resident-identity.service";
import { residentEmailCheckSchema } from "@/modules/users/resident-identity.validation";

export const runtime = "nodejs";

/**
 * The ID form's live "is this email free" check, fired after typing pauses.
 *
 * Signed-in only and rate limited, because an answer of TAKEN says an account
 * exists — cheap enough to be useful to the form, too slow to walk a list of
 * addresses. The save re-checks, so this is advice, not the guard.
 */
export async function GET(request: NextRequest) {
  try {
    const limited = rateLimitPublicForm(request, {
      limit: 30,
      namespace: "resident-email-check",
      windowMs: 60_000,
    });

    if (limited) {
      return limited;
    }

    const principal = await requireApiPrincipal(request);
    const { email } = residentEmailCheckSchema.parse({
      email: request.nextUrl.searchParams.get("email") ?? "",
    });

    return withEtag(request, successResponse(
      await checkResidentEmail(principal.userId, email),
      "Email checked",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
