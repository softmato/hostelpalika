import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listListingFlags } from "@/modules/listing-flags/listing-flag.service";
import { listingFlagListQuerySchema } from "@/modules/listing-flags/listing-flag.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformPrincipal(request);
    const query = listingFlagListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listListingFlags(query);

    return withEtag(request, successResponse(result, "Listing flags loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
