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
    const sinceParam = request.nextUrl.searchParams.get("since");
    const since = sinceParam ? new Date(sinceParam) : undefined;
    const result = await listNotifications(
      principal,
      undefined,
      filterBy,
      since && !Number.isNaN(since.getTime()) ? since : undefined,
    );

    return withEtag(request, successResponse(result, "Notifications loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
