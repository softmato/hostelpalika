import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { recordListingAppearances } from "@/modules/hostels/hostel-impression.service";
import { publicListingImpressionSchema } from "@/lib/hostels/hostel.validation";

export const runtime = "nodejs";

/**
 * Records that these hostels were shown in a result list.
 *
 * Split out of `GET /public/hostels`, which used to count inside the read. That
 * welded the counting to the serving: the moment the list carries a
 * `Cache-Control` header, a CDN hit answers the visitor without ever reaching
 * our code, and the appearance is never recorded. The owner's "Seen in search"
 * tile would have drifted further from the truth the more traffic the site got
 * — worst exactly when it starts to matter.
 *
 * Counting from the client instead means the CDN can cache the list as hard as
 * it likes. This is the same shape `POST /public/hostels/[slug]/views` already
 * uses for the "Page views" tile beside it.
 *
 * **It trades one inaccuracy for another, and that is the deal.** A blocked
 * beacon undercounts, where a cached response undercounted before — but this
 * error is roughly a constant fraction of real visitors instead of one that
 * grows with traffic.
 */
export async function POST(request: NextRequest) {
  try {
    const rateLimited = rateLimitPublicForm(request, {
      limit: 60,
      namespace: "hostel-listing-impression",
    });

    if (rateLimited) {
      return rateLimited;
    }

    const { hostelIds } = publicListingImpressionSchema.parse(await request.json());

    await recordListingAppearances(hostelIds);

    return successResponse({ recorded: true }, "Listing appearance recorded");
  } catch (error) {
    return handleRouteError(error);
  }
}
