import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireTeamPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { checkTeamOwnerEmail } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

const querySchema = z.object({ email: z.string().trim().email().max(254) });

/**
 * "Can this owner email be used?" — asked while the field agent is still typing.
 *
 * An email already tied to a live hostel cannot be used for another one, and
 * the registration itself refuses it (`assertTeamRegistrationIsNew`). This is
 * the same answer given early, so the agent learns it at the email field with
 * the owner still in front of them — not six steps later at Publish, after the
 * photos and the rooms are in.
 *
 * Team-gated, for the reason the superadmin's own email check is gated: an open
 * endpoint that says whether an address belongs to a hostel is a lookup worth
 * more to someone enumerating owners than to anyone else. Field agents register
 * hostels for a living and already see who owns what.
 *
 * Returns the hostel's name, not its id or owner — enough for the agent to say
 * "that address is on Everest Home" and no more.
 */
export async function GET(request: NextRequest) {
  try {
    await requireTeamPrincipal(request);

    const { email } = querySchema.parse({
      email: request.nextUrl.searchParams.get("email") ?? "",
    });

    const { status, usedBy } = await checkTeamOwnerEmail(email);

    return withEtag(request, successResponse(
      { available: status === "AVAILABLE" || status === "EXISTING_ACCOUNT", status, usedBy },
      "Email checked",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
