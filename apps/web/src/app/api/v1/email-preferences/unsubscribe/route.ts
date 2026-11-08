import type { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import {
  emailFromPreferenceToken,
  getMutedTopics,
  setMutedTopics,
} from "@/modules/notifications/email-preference.service";
import { isEmailTopic } from "@/lib/notifications/email-topics";

export const runtime = "nodejs";

/**
 * One-click unsubscribe (RFC 8058) — the URL in an optional email's
 * `List-Unsubscribe` header. Gmail and Yahoo POST `List-Unsubscribe=One-Click`
 * here when the reader presses their own Unsubscribe button; the body carries
 * nothing we need, so it is not read.
 *
 * POST only: a GET would let a link scanner unsubscribe people by prefetching.
 */
export async function POST(request: NextRequest) {
  try {
    const email = emailFromPreferenceToken(request.nextUrl.searchParams.get("token"));
    const topic = request.nextUrl.searchParams.get("topic");

    if (!email || !isEmailTopic(topic)) {
      return errorResponse("This unsubscribe link is not valid.", "INVALID_UNSUBSCRIBE_LINK", 400);
    }

    await setMutedTopics([email], [...(await getMutedTopics(email)), topic]);

    return successResponse({ unsubscribed: topic }, "Unsubscribed");
  } catch (error) {
    return handleRouteError(error);
  }
}
