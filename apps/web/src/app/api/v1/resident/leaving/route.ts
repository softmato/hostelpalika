import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  cancelLeavingNotice,
  getMyLeavingNotice,
  giveLeavingNotice,
  leavingNoticeSchema,
} from "@/modules/move-checklist/leaving-notice.service";

export const runtime = "nodejs";

/** My move-out notice and the earliest day I may name (field review E5). */
export async function GET(request: NextRequest) {
  try {
    return successResponse(await getMyLeavingNotice(await requireResidentPrincipal(request)), "Leaving notice");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Give or change my leaving day. No approval; the hostel is told at once. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const input = leavingNoticeSchema.parse(await request.json());

    return successResponse(await giveLeavingNotice(principal, input), "Leaving day saved");
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    return successResponse(await cancelLeavingNotice(await requireResidentPrincipal(request)), "Notice cancelled");
  } catch (error) {
    return handleRouteError(error);
  }
}
