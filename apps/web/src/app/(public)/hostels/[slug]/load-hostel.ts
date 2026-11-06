import "server-only";

import { cache } from "react";

import type { PublicHostel } from "@/app/_components/public-hostel-data";
import { searchImageUrls } from "@/lib/search-image-urls";
import { getPublicHostelBySlug, HostelServiceError } from "@/modules/hostels/hostel.service";

/**
 * One hostel, read once per request and shared by the layout, the metadata and
 * the page.
 *
 * The value goes through JSON so the client receives exactly what the API route
 * would have sent. Anything but "not found" is rethrown: a 5xx tells a search
 * engine to come back later, where a page rendered without its hostel would be
 * indexed as empty.
 */
export const loadHostel = cache(async (slug: string): Promise<PublicHostel | null> => {
  try {
    const { hostel } = await getPublicHostelBySlug(slug);
    return JSON.parse(JSON.stringify(hostel)) as PublicHostel;
  } catch (error) {
    if (error instanceof HostelServiceError && error.status === 404) {
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

  return hostel
    ? searchImageUrls(hostel.photos.map((photo) => photo.url ?? "").filter(Boolean))
    : [];
});
