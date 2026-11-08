import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { listWorkspaces } from "@/modules/hostels/hostel-workspace.service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The web portal's workspace switcher and access check (PARITY §9: the layout reads the API). */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);

    return successResponse(
      await listWorkspaces(principal, request.nextUrl.searchParams.get("slug")),
      "Workspaces loaded",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
