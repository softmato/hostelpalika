import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  createPlatformAdmin,
  listPlatformAdmins,
} from "@/modules/users/platform-admin.service";
import { platformAdminCreateSchema } from "@/modules/users/platform-admin.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);
    const result = await listPlatformAdmins();

    return withEtag(request, successResponse(result, "Platform admins loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const input = platformAdminCreateSchema.parse(await request.json());
    const result = await createPlatformAdmin(input, principal);

    return successResponse(result, "Platform admin created", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
