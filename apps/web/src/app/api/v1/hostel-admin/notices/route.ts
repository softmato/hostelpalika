import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { createNotice, listNotices } from "@/modules/notices/notice.service";
import {
  noticeCreateSchema,
  noticeListQuerySchema,
} from "@/modules/notices/notice.validation";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageNotices");
    const query = noticeListQuerySchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await listNotices(query, principal);

    return withEtag(request, successResponse(result, "Notices loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageNotices");
    const input = noticeCreateSchema.parse(await request.json());
    const result = await createNotice(input, principal);

    return successResponse(result, "Notice created", { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
