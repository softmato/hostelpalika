import { NextResponse, type NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { heldFileUrl } from "@/modules/hostels/hostel-leave.service";

export const runtime = "nodejs";

/** One file: a redirect to a 15-minute presigned link, never a lasting URL. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ fileId: string; requestId: string }> },
) {
  try {
    const principal = await requireApiPrincipal(request);
    const { fileId, requestId } = await params;
    const url = await heldFileUrl(principal.userId, requestId, fileId);

    // The app asks for the link itself: its downloader cannot follow a redirect
    // to R2 with the bearer token still on it (R2 reads it as a bad signature).
    if (request.nextUrl.searchParams.has("link")) {
      return successResponse({ url }, "File link ready");
    }

    const response = NextResponse.redirect(url, 302);

    response.headers.set("cache-control", "no-store");
    return response;
  } catch (error) {
    return handleRouteError(error);
  }
}
