import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  getAccountEmailPreference,
  updateAccountEmailPreference,
} from "@/modules/notifications/email-preference.service";
import { emailPreferenceUpdateSchema } from "@/modules/notifications/notification.validation";

export const runtime = "nodejs";

/**
 * Which optional emails this account gets — the Emails section of the app's
 * Settings. Applies to every address the account is mailed at; `hasEmail: false`
 * means there is nothing to mail and the screen hides the section.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const preference = await getAccountEmailPreference(principal.userId);

    return withEtag(request, successResponse({ preference }, "Email preferences loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const input = emailPreferenceUpdateSchema.parse(await request.json());
    const preference = await updateAccountEmailPreference(principal.userId, input.mutedTopics);

    return successResponse({ preference }, "Email preferences saved");
  } catch (error) {
    return handleRouteError(error);
  }
}
