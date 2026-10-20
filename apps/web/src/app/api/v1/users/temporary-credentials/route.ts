import type { NextRequest } from "next/server";

import { assertPrimaryCredentialPrincipal, requireApiPrincipal } from "@/lib/api-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { rateLimitAuthAttempts } from "@/lib/rate-limit";
import {
  createTemporaryCredential,
  listTemporaryCredentials,
  TemporaryCredentialError,
} from "@/modules/auth/temporary-credential.service";
import { temporaryCredentialCreateSchema } from "@/modules/auth/temporary-credential.validation";

export const runtime = "nodejs";

/**
 * Account-level, not portal-level: a hostel admin and a resident manage their
 * temporary logins through this same pair of endpoints, because the thing being
 * managed is the account, and every role has exactly one.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);

    // Owner-only like the writes below: someone holding a borrowed login has no
    // business enumerating the account's other access credentials, even though
    // they could not act on them.
    assertPrimaryCredentialPrincipal(principal);

    return withEtag(request, successResponse(
      await listTemporaryCredentials(principal.userId),
      "Temporary logins",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);

    // Only the real owner may mint one; a borrowed login extending itself would
    // defeat the expiry date it was issued under.
    assertPrimaryCredentialPrincipal(principal);

    // Issuing is cheap and the password is generated, so the cap here is about
    // stopping a hijacked session from spraying usernames, not about guessing.
    const limited = rateLimitAuthAttempts(request, "auth-temporary-credentials");

    if (limited) {
      return limited;
    }

    const input = temporaryCredentialCreateSchema.parse(await request.json());
    const result = await createTemporaryCredential(principal.userId, input);

    return successResponse(
      result,
      "Temporary login created. Copy the password now — it is not shown again.",
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof TemporaryCredentialError) {
      return errorResponse(error.message, error.errorCode, error.status);
    }

    return handleRouteError(error);
  }
}
