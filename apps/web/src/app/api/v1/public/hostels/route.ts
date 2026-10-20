import type { NextRequest } from "next/server";

import {
  PUBLIC_CACHE,
  handleRouteError,
  successResponse,
} from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listPublicHostels } from "@/modules/hostels/hostel.service";
import { publicHostelListQuerySchema } from "@/modules/hostels/hostel.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const query = publicHostelListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listPublicHostels(query);

    /*
     * Search appearances are **not** counted here any more.
     *
     * They used to be, in an `afterResponse`. That was correct right up until
     * this response got a cache header: a CDN hit never runs this function, so
     * the count would have quietly missed every cached visitor. The client
     * reports them to `POST /public/hostels/impressions` instead — the same
     * split `POST /public/hostels/[slug]/views` already uses for page views.
     */
    return withEtag(request, successResponse(result, "Public hostels loaded", PUBLIC_CACHE));
  } catch (error) {
    return handleRouteError(error);
  }
}
