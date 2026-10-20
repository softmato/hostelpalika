import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  getAccountDeletionStatus,
  requestAccountDeletion,
} from "@/modules/users/account-deletion.service";
import { accountDeletionRequestSchema } from "@/modules/users/account-deletion.validation";

export const runtime = "nodejs";

/** What the delete button will do for this account, and any open request. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const result = await getAccountDeletionStatus(principal);

    return withEtag(request, successResponse(result, "Account deletion status loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const input = accountDeletionRequestSchema.parse(await request.json());
    const result = await requestAccountDeletion(input, principal);

    return successResponse(result, result.message, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
