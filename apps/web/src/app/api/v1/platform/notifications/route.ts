import type { NextRequest } from "next/server";

import { requirePlatformPrincipal, requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  createPlatformNotificationCampaign,
  listPlatformNotificationCampaigns,
} from "@/modules/notifications/notification-campaign.service";
import { platformNotificationCampaignSchema } from "@/modules/notifications/notification.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformPrincipal(request);
    const result = await listPlatformNotificationCampaigns();

    return withEtag(request, successResponse(result, "Platform notification campaigns loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Broadcasting to every resident on the platform is a superadmin action — a
 * moderator moderates content and does not address the whole user base.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const input = platformNotificationCampaignSchema.parse(await request.json());
    const result = await createPlatformNotificationCampaign(input, principal);

    return successResponse(result, "Platform notification sent", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
