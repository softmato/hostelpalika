import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listResidentSOSAlerts, triggerSOS } from "@/modules/safety/safety.service";
import { sosCreateSchema } from "@/modules/safety/safety.validation";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const input = sosCreateSchema.parse(await request.json());
    const result = await triggerSOS(input, principal);

    return successResponse(result, "SOS alert triggered", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * The resident's own alert history, newest first.
 *
 * There was no resident-facing read of `SOSAlert` at all: raising one was
 * write-only from the app's side, so the only trace a resident could see was the
 * word `SOS_TRIGGERED` stuck on their night status. This is the record — what
 * was raised, when, and whether the hostel has settled it.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);

    return withEtag(request, successResponse(await listResidentSOSAlerts(principal), "SOS alerts"));
  } catch (error) {
    return handleRouteError(error);
  }
}
