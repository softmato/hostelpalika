import type { NextRequest } from "next/server";

import { PUBLIC_CACHE, handleRouteError, successResponse } from "@/lib/api-response";
import { listPublishedHostelSlugs } from "@/modules/hostels/hostel.service";
import { resolveSearchImageUrls } from "@/modules/hostels/search-image-urls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Every published hostel for sitemap.xml, or one with `?slug=` for its social
 * card and structured data (PARITY §9: the web reads the API). Photos come back
 * as absolute public media URLs — stored `/api/v1/files/<id>/url` paths only
 * work in a browser, and a sitemap `<image:loc>` must be crawlable.
 */
export async function GET(request: NextRequest) {
  try {
    const slug = request.nextUrl.searchParams.get("slug") || undefined;
    const hostels = await listPublishedHostelSlugs(slug);
    const images = await resolveSearchImageUrls(hostels.flatMap((hostel) => hostel.images));

    return successResponse(
      {
        hostels: hostels.map((hostel) => ({
          images: hostel.images.map((url) => images.get(url)).filter((url): url is string => Boolean(url)),
          slug: hostel.slug,
          updatedAt: hostel.updatedAt ?? null,
        })),
      },
      "Published hostels loaded",
      PUBLIC_CACHE,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
