import type { NextRequest } from "next/server";

import { assertApiRoles, requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { Role } from "@/lib/roles";
import { listAccountDeletionRequests } from "@/modules/users/account-deletion.service";
import { accountDeletionListQuerySchema } from "@/modules/users/account-deletion.validation";

export const runtime = "nodejs";

/**
 * The platform owner's review queue. SUPERADMIN only — a moderator approves
 * hostel listings, but closing an owner's account is the owner's own call to
 * make (PRD.md §7 keeps account-level actions with the superadmin).
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requirePlatformPrincipal(request);

    assertApiRoles(principal, [Role.SUPERADMIN]);

    const query = accountDeletionListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    const result = await listAccountDeletionRequests(query);

    return withEtag(request, successResponse(result, "Account deletion requests loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
