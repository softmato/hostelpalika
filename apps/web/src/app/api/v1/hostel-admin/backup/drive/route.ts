import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { disconnectDrive, driveConnectUrl } from "@/modules/backup/backup.service";

export const runtime = "nodejs";

/** The Google consent URL to open (connect or reconnect). */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;
    const { from } = z
      .object({ from: z.enum(["app", "web"]).default("web") })
      .parse(await request.json().catch(() => ({})));

    return successResponse(await driveConnectUrl(principal, hostelId, from), "Open Google to connect Drive");
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;

    await disconnectDrive(principal, hostelId);

    return successResponse({ disconnected: true }, "Drive disconnected");
  } catch (error) {
    return handleRouteError(error);
  }
}
