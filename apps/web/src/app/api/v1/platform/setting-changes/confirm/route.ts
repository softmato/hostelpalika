import { revalidatePath } from "next/cache";
import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  confirmSettingChange,
  previewSettingChange,
} from "@/modules/platform-config/setting-change.service";

export const runtime = "nodejs";

/** What the emailed link would change, for the confirm page. Same account only. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const token = request.nextUrl.searchParams.get("token") ?? "";
    const change = await previewSettingChange(token, principal);

    return withEtag(request, successResponse({ change }, "Change loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Applies the change behind the link. Once, before it expires, same account only. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const body = (await request.json().catch(() => ({}))) as { token?: unknown };

    if (typeof body.token !== "string" || body.token.length === 0) {
      return errorResponse("The confirmation link is missing its code.", "VALIDATION_ERROR", 422);
    }

    const result = await confirmSettingChange(body.token, principal);
    // Booking terms feed the public policy pages, cached for an hour.
    revalidatePath("/", "layout");

    return successResponse(result, `Saved the change to ${result.label}.`);
  } catch (error) {
    return handleRouteError(error);
  }
}
