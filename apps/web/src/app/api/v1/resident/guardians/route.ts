import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  inviteGuardian,
  listResidentGuardians,
} from "@/modules/guardian/guardian-invite.service";
import { guardianInviteSchema } from "@/modules/guardian/guardian.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const result = await listResidentGuardians(principal);

    return withEtag(request, successResponse(result, "Guardians loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const input = guardianInviteSchema.parse(await request.json());
    const result = await inviteGuardian(input, principal);

    return successResponse(result, "Guardian invited", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
