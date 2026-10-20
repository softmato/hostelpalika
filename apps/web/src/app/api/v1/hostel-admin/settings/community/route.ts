import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { assertHostelScopedApiAccess } from "@/lib/api-auth";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { HostelSettingsModel } from "@hostel/db/models/HostelSettings";
import { connectToDatabase } from "@/lib/db";
import { getCommunitySettings } from "@/modules/community/community-settings";

export const runtime = "nodejs";

const communitySettingsSchema = z.object({
  enabled: z.boolean().optional(),
  hostelId: z
    .string()
    .regex(/^[a-f\d]{24}$/i)
    .optional(),
  profanityFilterEnabled: z.boolean().optional(),
});

/** Whether the caller may configure this hostel, and which one it is. */
function resolveHostelId(
  principal: { hostelIds: string[]; role: string; userId: string },
  requested?: string,
) {
  if (requested) {
    assertHostelScopedApiAccess(principal as never, requested);
    return requested;
  }

  if (principal.hostelIds.length === 1) {
    return principal.hostelIds[0];
  }

  throw Object.assign(new Error("A hostelId is required for this action."), {
    errorCode: "HOSTEL_SCOPE_REQUIRED",
    status: 422,
  });
}

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const hostelId = resolveHostelId(
      principal,
      request.nextUrl.searchParams.get("hostelId") ?? undefined,
    );

    await connectToDatabase();

    return withEtag(request, successResponse(
      { hostelId, settings: await getCommunitySettings(hostelId) },
      "Community settings loaded",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const input = communitySettingsSchema.parse(await request.json());
    const hostelId = resolveHostelId(principal, input.hostelId);

    await connectToDatabase();

    const current = await getCommunitySettings(hostelId);
    const next = {
      enabled: input.enabled ?? current.enabled,
      profanityFilterEnabled:
        input.profanityFilterEnabled ?? current.profanityFilterEnabled,
    };

    await HostelSettingsModel.updateOne(
      { hostelId },
      { $set: { community: next, updatedBy: principal.userId } },
      { upsert: true },
    );
    await AuditLogModel.create({
      action: "COMMUNITY_SETTINGS_UPDATED",
      actorId: principal.userId,
      entityId: hostelId,
      entityType: "HostelSettings",
      hostelId,
      metadata: next,
    });

    return successResponse({ settings: next }, "Community settings updated");
  } catch (error) {
    return handleRouteError(error);
  }
}
