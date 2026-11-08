import "server-only";

import { cache } from "react";

import type { PublicHostel } from "@/app/_components/public-hostel-data";
import { serverApi, ServerApiError } from "@/lib/server-api";

/**
 * One hostel, read once per request and shared by the layout, the metadata and
 * the page.
 *
 * Read from the API (PARITY §9), so the client receives exactly what the API
 * route sends. Anything but "not found" is rethrown: a 5xx tells a search
 * engine to come back later, where a page rendered without its hostel would be
 * indexed as empty.
 */
export const loadHostel = cache(async (slug: string): Promise<PublicHostel | null> => {
  try {
    const { hostel } = await serverApi<{ hostel: PublicHostel }>(`/api/v1/public/hostels/${encodeURIComponent(slug)}`);
    return hostel;
  } catch (error) {
    if (error instanceof ServerApiError && error.status === 404) {
      return null;
    }
    throw error;
  }
});

/**
 * The hostel's photos as absolute public media URLs, for the social card and
 * structured data — the stored `/api/v1/files/<id>/url` paths only work in a
 * browser.
 */
export const loadSearchPhotos = cache(async (slug: string) => {
  const hostel = await loadHostel(slug);

  if (!hostel) return [];

  const listed = await serverApi<{ hostels: Array<{ images: string[] }> }>(
    `/api/v1/public/hostels/sitemap?slug=${encodeURIComponent(slug)}`,
  ).catch(() => null);

  // A sample listing is not in the database; its photos are already absolute.
  return listed?.hostels[0]?.images ?? hostel.photos.map((photo) => photo.url ?? "").filter((url) => url.startsWith("https://"));
});
