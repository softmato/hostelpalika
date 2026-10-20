import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { checkPlatformAdminEmail } from "@/modules/users/platform-admin-invite.service";
import { platformAdminEmailCheckSchema } from "@/modules/users/platform-admin.validation";

export const runtime = "nodejs";

/**
 * Answers "is this address free?" while the superadmin is still typing it.
 *
 * Superadmin-gated like the rest of the roster, and deliberately so: an open
 * endpoint that says whether an address has an account is an account-existence
 * oracle, which is worth more to somebody enumerating a user list than it is to
 * anybody else. The people who can call it can already read the whole roster.
 *
 * A GET with the address in the query string rather than a POST, because it
 * reads and changes nothing — which is also what lets the client cancel a
 * request mid-flight as the next keystroke arrives without leaving anything
 * half-done behind it.
 */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    const roleParam = request.nextUrl.searchParams.get("role");
    const { email, role } = platformAdminEmailCheckSchema.parse({
      email: request.nextUrl.searchParams.get("email") ?? "",
      ...(roleParam ? { role: roleParam } : {}),
    });

    return withEtag(request, successResponse(await checkPlatformAdminEmail(email, role), "Email checked"));
  } catch (error) {
    return handleRouteError(error);
  }
}
