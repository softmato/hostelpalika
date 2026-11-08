import type { NextRequest } from "next/server";

import { loadApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { createPublicHostelInquiry } from "@/modules/hostels/hostel.service";
import { publicInquiryCreateSchema } from "@/lib/hostels/hostel.validation";
import { shouldPromptAfterInquiry } from "@/modules/users/resident-identity.service";

type RouteContext = {
  params: Promise<{
    slug: string;
  }>;
};

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const rateLimited = rateLimitPublicForm(request, {
      namespace: "public-hostel-inquiry",
    });

    if (rateLimited) {
      return rateLimited;
    }

    const { slug: hostelRef } = await context.params;
    const input = publicInquiryCreateSchema.parse(await request.json());
    const result = await createPublicHostelInquiry(hostelRef, input);
    // Sending an inquiry is the clearest signal someone is about to move in —
    // the best moment to offer the fill-once resident profile.
    const principal = await loadApiPrincipal(request);
    const shouldCollectProfile = await shouldPromptAfterInquiry(
      principal?.userId,
      input.email,
    ).catch(() => false);

    return successResponse({ ...result, shouldCollectProfile }, "Inquiry submitted", {
      status: 201,
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
