import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { readPlatformAdminInvitation } from "@/modules/users/platform-admin-invite.service";

export const runtime = "nodejs";

/**
 * Public by design — the token is the authorisation, as it is for
 * `guardian/accept-invitation` and `cook/accept-invitation`. Requiring a
 * session first would mean asking somebody to sign in to an account that may
 * not exist yet.
 *
 * It sits outside `/api/v1/platform/` on purpose: everything under that prefix
 * is superadmin-gated, and a public route hiding among them is the kind of
 * thing a later reader trusts without checking.
 */
export async function GET(request: NextRequest) {
  try {
    const token = request.nextUrl.searchParams.get("token")?.trim() ?? "";

    return withEtag(request, successResponse(
      await readPlatformAdminInvitation(token),
      "Invitation loaded",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
