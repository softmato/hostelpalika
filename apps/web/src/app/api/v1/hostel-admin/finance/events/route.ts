import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { reviewQueueQuerySchema } from "@/modules/finance/claim.validation";
import { listReviewQueue } from "@/modules/finance/review.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/** The review queue: claims awaiting a decision (target §11.4). */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewPayments");
    const query = reviewQueueQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const hostelId = resolveAdminHostelId(principal, query.hostelId);

    return withEtag(request, successResponse(
      { events: await listReviewQueue(hostelId, query.status) },
      "Payment claims",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
