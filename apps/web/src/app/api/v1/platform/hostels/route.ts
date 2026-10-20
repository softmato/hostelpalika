import type { NextRequest } from "next/server";

import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { requirePlatformPrincipal } from "@/lib/api-auth";
import {
  createPlatformHostelApplication,
  listPlatformHostels,
} from "@/modules/hostels/hostel.service";
import {
  platformHostelCreateSchema,
  platformHostelListQuerySchema,
} from "@/modules/hostels/hostel.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    await requirePlatformPrincipal(request);

    const query = platformHostelListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listPlatformHostels(query);

    return withEtag(request, successResponse(result, "Hostel applications loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requirePlatformPrincipal(request);
    const input = platformHostelCreateSchema.parse(await request.json());
    const result = await createPlatformHostelApplication(input, principal);

    return successResponse(result, "Hostel application created", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
