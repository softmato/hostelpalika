import type { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { searchPlaces } from "@/lib/maps/geocoding";
import { rateLimitPublicForm } from "@/lib/rate-limit";

export const runtime = "nodejs";

/** Answers repeat for a day: a college does not move. Per instance, which is enough. */
const CACHE_MS = 24 * 60 * 60_000;
const cache = new Map<string, { at: number; places: { lat: number; lng: number; name: string }[] }>();

/**
 * Place search for the app's "My college / office": a name in, a few
 * `{ name, lat, lng }` out. Proxied so the phone never talks to the geocoder
 * directly (Nominatim's policy wants one identified client, not thousands),
 * rate limited per client, and cached.
 */
export async function GET(request: NextRequest) {
  try {
    const rateLimited = rateLimitPublicForm(request, { namespace: "place-search" });

    if (rateLimited) {
      return rateLimited;
    }

    const query = (request.nextUrl.searchParams.get("q") ?? "").trim().slice(0, 80);

    if (query.length < 3) {
      return errorResponse("Type at least 3 letters.", "QUERY_TOO_SHORT", 400);
    }

    const key = query.toLowerCase();
    const hit = cache.get(key);

    if (hit && Date.now() - hit.at < CACHE_MS) {
      return successResponse({ places: hit.places });
    }

    const places = (await searchPlaces(`${query}, Nepal`, 6)).map((result) => ({
      lat: result.coordinates.lat,
      lng: result.coordinates.lng,
      name: result.label ?? query,
    }));

    if (cache.size > 500) {
      cache.clear();
    }

    cache.set(key, { at: Date.now(), places });

    return successResponse({ places });
  } catch (error) {
    return handleRouteError(error);
  }
}
