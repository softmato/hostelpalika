import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { platformPushSchema } from "@/modules/notifications/notification.validation";
import {
  listPlatformPushes,
  sendPlatformPush,
} from "@/modules/notifications/platform-push.service";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    return withEtag(request, successResponse(await listPlatformPushes(), "Push notifications loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Superadmin only — a moderator does not address every device on the platform. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const input = platformPushSchema.parse(await request.json());
    const result = await sendPlatformPush(input, principal);

    return successResponse(result, "Push notification sent", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
