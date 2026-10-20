import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { lookupLocation } from "@/modules/hostels/hostel-geocode.service";
import { hostelAdminGeocodeQuerySchema } from "@/modules/hostels/hostel.validation";

export const runtime = "nodejs";

/**
 * The location lookup for an owner placing their own hostel on the map while
 * they apply — the third desk behind `lookupLocation`, after the hostel admin's
 * profile and the team registration form.
 *
 * The applicant has no hostel to hold a capability on and is not staff, so the
 * guard is a signed-in account (the phone's application flow already requires
 * one) plus a per-client rate limit. That keeps a paid upstream call away from
 * anonymous traffic, which is what the other two guards exist for, without
 * locking the owner out of the pin their own listing is measured from.
 *
 * Sixty a minute: a search box fires a lookup per submitted query and a reverse
 * lookup per placed pin, and an owner nudging the map onto their gate places
 * several.
 */
export async function GET(request: NextRequest) {
  try {
    const rateLimited = rateLimitPublicForm(request, {
      limit: 60,
      namespace: "public-hostel-registration-geocode",
    });

    if (rateLimited) {
      return rateLimited;
    }

    await requireApiPrincipal(request);
    const query = hostelAdminGeocodeQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );

    const result = await lookupLocation(query);

    return withEtag(request, successResponse(result, query.q ? "Location search complete" : "Address lookup complete"));
  } catch (error) {
    return handleRouteError(error);
  }
}
