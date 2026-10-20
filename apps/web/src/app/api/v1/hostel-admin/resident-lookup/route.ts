import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { lookupResidentProfile } from "@/modules/users/resident-identity.service";
import { residentIdLookupSchema } from "@/modules/users/resident-identity.validation";

export const runtime = "nodejs";

/**
 * Pulls a person's saved profile by their resident ID (typed in, or read off
 * their QR) so registering them is a review-and-confirm rather than a retype.
 *
 * Gated on the same `registerResidents` capability as creating a resident, and
 * rate limited: the ID is short enough that an unthrottled endpoint would be
 * guessable.
 */
export async function GET(request: NextRequest) {
  try {
    const rateLimited = rateLimitPublicForm(request, {
      limit: 20,
      namespace: "resident-profile-lookup",
    });

    if (rateLimited) {
      return rateLimited;
    }

    const principal = await requireHostelCapability(request, "registerResidents");
    const query = residentIdLookupSchema.parse(
      Object.fromEntries(request.nextUrl.searchParams.entries()),
    );
    const result = await lookupResidentProfile(
      query.residentId,
      principal,
      query.hostelId,
    );

    return withEtag(request, successResponse(result, "Resident profile loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}
