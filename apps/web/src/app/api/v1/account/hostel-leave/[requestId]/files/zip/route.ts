import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError } from "@/lib/api-response";
import { heldFilesZip } from "@/modules/hostels/hostel-leave.service";

export const runtime = "nodejs";
// A part is capped at 200 MB (`LEAVE_ZIP_PART_BYTES`) so it streams well inside this.
export const maxDuration = 300;

/** Every original file of one part, streamed as a ZIP. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ requestId: string }> }) {
  try {
    const principal = await requireApiPrincipal(request);
    const { requestId } = await params;
    const part = Math.max(1, Number(request.nextUrl.searchParams.get("part")) || 1);
    const { filename, stream } = await heldFilesZip(principal.userId, requestId, part);

    return new Response(stream, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${filename}"`,
        "content-type": "application/zip",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
