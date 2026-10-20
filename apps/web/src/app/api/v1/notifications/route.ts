import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  listNotifications,
  type NotificationFilter,
} from "@/modules/notifications/notification.service";

export const runtime = "nodejs";

function parseFilter(value: string | null): NotificationFilter {
  return value === "unread" || value === "action" ? value : "all";
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const filterBy = parseFilter(request.nextUrl.searchParams.get("filter"));
    const result = await listNotifications(principal, undefined, filterBy);

    return withEtag(request, successResponse(result, "Notifications loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
