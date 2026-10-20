import type { NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  createHostelNotificationCampaign,
  listHostelNotificationCampaigns,
} from "@/modules/notifications/notification-campaign.service";
import {
  hostelNotificationCampaignSchema,
  notificationCampaignListQuerySchema,
} from "@/modules/notifications/notification.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const query = notificationCampaignListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams),
    );
    const result = await listHostelNotificationCampaigns(query, principal);

    return withEtag(request, successResponse(result, "Notification campaigns loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const input = hostelNotificationCampaignSchema.parse(await request.json());
    const result = await createHostelNotificationCampaign(input, principal);

    return successResponse(result, "Notification campaign created", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
