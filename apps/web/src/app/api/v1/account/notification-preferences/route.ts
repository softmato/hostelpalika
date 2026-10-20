import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  getNotificationPreference,
  updateNotificationPreference,
} from "@/modules/notifications/notification-preference.service";
import { notificationPreferenceUpdateSchema } from "@/modules/notifications/notification.validation";

export const runtime = "nodejs";

/**
 * What this account wants to be interrupted by.
 *
 * Scoped to the caller with no role branch — everybody has notifications, and a
 * preference is nobody else's business. Answers the defaults for an account that
 * has never saved one rather than 404ing: the screen has something to render on
 * first open, and `null` would only push that decision into the client.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const preference = await getNotificationPreference(principal.userId);

    return withEtag(request, successResponse({ preference }, "Notification preferences loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const input = notificationPreferenceUpdateSchema.parse(await request.json());
    const preference = await updateNotificationPreference(principal.userId, input);

    return successResponse({ preference }, "Notification preferences saved");
  } catch (error) {
    return handleRouteError(error);
  }
}
