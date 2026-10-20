import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { requireHostelCapability } from "@/lib/api-auth";
import { lookupLocation } from "@/modules/hostels/hostel-geocode.service";
import { hostelAdminGeocodeQuerySchema } from "@/modules/hostels/hostel.validation";

export const runtime = "nodejs";

/**
 * Location lookup for the profile location picker, in both directions:
 *
 * - `?q=` — a place name, a pasted Google Maps / OSM link, or a raw `lat,lng`
 *   pair. Links are resolved server-side because following a `maps.app.goo.gl`
 *   redirect is impossible from the browser (cross-origin).
 * - `?lat=&lng=` — what address that pin sits on, so the address fields can
 *   follow the map.
 *
 * Staff-only — this is a paid upstream call, not something anonymous traffic
 * should be able to drive. The lookup itself is shared with the team
 * registration desk (`/api/v1/team/geocode`), which has its own guard.
 */
export async function GET(request: NextRequest) {
  try {
    await requireHostelCapability(request, "editHostelProfile");
    const query = hostelAdminGeocodeQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );

    const result = await lookupLocation(query);

    return withEtag(request, successResponse(result, query.q ? "Location search complete" : "Address lookup complete"));
  } catch (error) {
    return handleRouteError(error);
  }
}
