import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  invitePlatformAdmin,
  invitePlatformAdmins,
  listPlatformAdminInvites,
} from "@/modules/users/platform-admin-invite.service";
import {
  platformAdminBulkInviteSchema,
  platformAdminInviteSchema,
} from "@/modules/users/platform-admin.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    return withEtag(request, successResponse(await listPlatformAdminInvites(), "Invitations loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Sends one invitation, or a batch.
 *
 * The two shapes share an endpoint rather than splitting into `/invites` and
 * `/invites/bulk`, because they are the same act with a different arity and a
 * caller should not have to pick a URL based on how many rows the user happened
 * to fill in. A body carrying `invitations` is a batch; anything else is a
 * single send.
 *
 * A batch answers 200 rather than 201 even when every one succeeds: it reports
 * per-address outcomes, and some of them may have failed, so "created" would be
 * a claim the body then contradicts.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const body = await request.json();

    if (body && typeof body === "object" && "invitations" in body) {
      const input = platformAdminBulkInviteSchema.parse(body);
      const result = await invitePlatformAdmins(input, principal);

      return successResponse(
        result,
        `${result.sent} of ${result.total} invitations sent`,
      );
    }

    const input = platformAdminInviteSchema.parse(body);

    return successResponse(
      await invitePlatformAdmin(input, principal),
      "Invitation sent",
      { status: 201 },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
