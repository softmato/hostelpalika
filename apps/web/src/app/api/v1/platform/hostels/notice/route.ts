import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { hostelNoticeSchema } from "@/lib/hostels/hostel.validation";
import { sendPlatformHostelNotice } from "@/modules/hostels/hostel-notify";

export const runtime = "nodejs";

/**
 * A personal (one hostel) or group notice to hostel owners, by email and/or
 * push. Superadmin only, like every other platform broadcast.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const input = hostelNoticeSchema.parse(await request.json());
    const result = await sendPlatformHostelNotice(input, principal);

    return successResponse(result, "Notice sent");
  } catch (error) {
    return handleRouteError(error);
  }
}
