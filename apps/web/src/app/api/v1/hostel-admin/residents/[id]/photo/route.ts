import { NextResponse, type NextRequest } from "next/server";

import { requireHostelStaffPrincipal } from "@/lib/api-auth";
import { handleRouteError } from "@/lib/api-response";
import { readResidentPhoto } from "@/modules/residents/resident.service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * A resident's admission-form photo. Streamed, not redirected — the bucket is
 * private and a redirect to a presigned URL would drop the caller's
 * `Authorization` header. Staff of the resident's own hostel only.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireHostelStaffPrincipal(request);
    const { id } = await context.params;
    const photo = await readResidentPhoto(id, principal);

    return new NextResponse(photo.body, {
      headers: {
        "Cache-Control": "private, max-age=3600",
        "Content-Type": photo.contentType,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
