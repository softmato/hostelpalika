import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  getResidentIdentity,
  saveResidentIdentity,
  setResidentIdentitySharing,
} from "@/modules/users/resident-identity.service";
import {
  residentIdentitySaveSchema,
  residentIdentitySharingSchema,
} from "@/modules/users/resident-identity.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const result = await getResidentIdentity(principal.userId);

    return withEtag(request, successResponse(result, "Resident identity loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const input = residentIdentitySaveSchema.parse(await request.json());
    const result = await saveResidentIdentity(principal.userId, input);

    return successResponse(result, "Resident profile saved");
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const input = residentIdentitySharingSchema.parse(await request.json());
    const result = await setResidentIdentitySharing(
      principal.userId,
      input.sharingEnabled,
    );

    return successResponse(
      result,
      input.sharingEnabled ? "Sharing turned on" : "Sharing turned off",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
