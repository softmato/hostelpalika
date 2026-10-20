import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { addCookAccount, listCookAccounts } from "@/modules/food/cook-roster.service";
import { cookCreateSchema } from "@/modules/food/cook.validation";

export const runtime = "nodejs";

/**
 * The hostel's cook roster.
 *
 * Gated on `manageFood`, the same capability the food routine and the portal
 * switch are behind: deciding who cooks and deciding what is cooked are one
 * person's job, and a warden who can edit the menu can staff the kitchen.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageFood");
    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;

    return withEtag(request, successResponse(await listCookAccounts(principal, hostelId), "Cooks loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Adds a cook: `kind: "CREDENTIAL"` mints a short login and returns its
 * first-time password **once**, `kind: "INVITE"` emails an address and returns
 * no secret at all.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageFood");
    const input = cookCreateSchema.parse(await request.json());
    const result = await addCookAccount(input, principal);

    return successResponse(
      result,
      input.kind === "CREDENTIAL" ? "Cook sign-in created" : "Invitation sent",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
