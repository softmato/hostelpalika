import type { NextRequest } from "next/server";

import { PUBLIC_CACHE, handleRouteError, successResponse } from "@/lib/api-response";
import { listPublicHostelsNear, listPublicHostelsNearAll } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/**
 * Every campus a published hostel found nearby, each with those hostels and
 * their distances — or one campus with `?place=` (a 404 when nothing is near it).
 * The `/hostels/near` pages' data (PARITY §9).
 */
export async function GET(request: NextRequest) {
  try {
    const slug = request.nextUrl.searchParams.get("place");
    const entries = slug
      ? [await listPublicHostelsNear(slug)].filter((entry) => entry !== null)
      : await listPublicHostelsNearAll();

    return successResponse(
      {
        places: entries.map(({ hostels, place: { distances: _distances, ...place } }) => ({ hostels, place })),
      },
      "Nearby places loaded",
      PUBLIC_CACHE,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
