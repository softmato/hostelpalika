import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  getResidentNightStatus,
  updateResidentNightStatus,
} from "@/modules/safety/safety.service";
import { nightStatusUpdateSchema } from "@/modules/safety/safety.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const result = await getResidentNightStatus(principal);

    return withEtag(request, successResponse(result, "Night status loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireResidentPrincipal(request);
    const input = nightStatusUpdateSchema.parse(await request.json());
    const result = await updateResidentNightStatus(input, principal);

    return successResponse(result, "Night status updated");
  } catch (error) {
    return handleRouteError(error);
  }
}
