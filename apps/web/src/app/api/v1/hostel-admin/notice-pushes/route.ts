import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { createNoticePush, listNoticePushes } from "@/modules/notices/notice-push.service";
import {
  noticePushCreateSchema,
  noticePushListQuerySchema,
} from "@/modules/notices/notice-push.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageNotices");
    const query = noticePushListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );

    return withEtag(request, successResponse(
      await listNoticePushes(principal, query.hostelId),
      "Push notices loaded",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageNotices");
    const input = noticePushCreateSchema.parse(await request.json());

    return successResponse(await createNoticePush(input, principal), "Push notice saved", {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
