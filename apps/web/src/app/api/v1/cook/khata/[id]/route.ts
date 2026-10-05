import type { NextRequest } from "next/server";

import { assertApiRoles, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { Role } from "@/lib/roles";
import { decideKhataOrder, khataOrderDecisionSchema } from "@/modules/finance/khata.service";
import { resolveCookHostelId } from "@/modules/food/cook.service";

export const runtime = "nodejs";

/** Hand an ask over (it is now owed) or say it is not available. */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const principal = await requireApiPrincipal(request);
    assertApiRoles(principal, [Role.COOK, Role.HOSTEL_ADMIN, Role.WARDEN]);
    const { id } = await context.params;
    const input = khataOrderDecisionSchema.parse(await request.json());
    const hostelId = await resolveCookHostelId(principal, input.hostelId);

    return successResponse(
      await decideKhataOrder(hostelId, id, input.action, principal),
      input.action === "GIVE" ? "Given" : "Marked not available",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
