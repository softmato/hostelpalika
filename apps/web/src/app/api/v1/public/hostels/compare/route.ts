import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { comparePublicHostels } from "@/modules/hostels/hostel.service";
import { publicHostelCompareQuerySchema } from "@/modules/hostels/hostel.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const query = publicHostelCompareQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await comparePublicHostels(query);

    return withEtag(request, successResponse(result, "Hostel comparison loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
