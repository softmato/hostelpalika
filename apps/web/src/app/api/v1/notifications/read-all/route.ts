import type { NextRequest } from "next/server";

import { requestsOverall, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { markAllNotificationsRead } from "@/modules/notifications/notification.service";

export const runtime = "nodejs";

/** "Mark all read" from the bell. Only ever touches the caller's own rows. */
export async function PATCH(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const result = await markAllNotificationsRead(principal, requestsOverall(request));

    return successResponse(result, "Notifications marked as read");
  } catch (error) {
    return handleRouteError(error);
  }
}
