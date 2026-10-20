import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  listTeamInvites,
  listTeamRegistrations,
  listTeamRoster,
} from "@/modules/team/team.service";

export const runtime = "nodejs";

/**
 * The Team tab: who is on the field team, and every hostel they have filed.
 *
 * Superadmin only, matching the invitation endpoints — a platform moderator
 * moderates content and has no business in commercial attribution.
 */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    const [roster, registrations, invites] = await Promise.all([
      listTeamRoster(),
      listTeamRegistrations(),
      listTeamInvites(),
    ]);

    return withEtag(request, successResponse({ ...roster, ...registrations, ...invites }, "Team loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
