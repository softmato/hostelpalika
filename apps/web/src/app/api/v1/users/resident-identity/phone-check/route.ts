import type { NextRequest } from "next/server";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { checkResidentPhone } from "@/modules/users/resident-identity.service";
import { residentPhoneCheckSchema } from "@/modules/users/resident-identity.validation";

export const runtime = "nodejs";

/**
 * The ID form's live "is this number free" check, fired after typing pauses —
 * the phone half of `email-check`, on the same terms: signed-in only and rate
 * limited, because TAKEN says an account exists. The save re-checks, so this is
 * advice, not the guard.
 */
export async function GET(request: NextRequest) {
  try {
    const limited = rateLimitPublicForm(request, {
      limit: 30,
      namespace: "resident-phone-check",
      windowMs: 60_000,
    });

    if (limited) {
      return limited;
    }

    const principal = await requireApiPrincipal(request);
    const { phone } = residentPhoneCheckSchema.parse({
      phone: request.nextUrl.searchParams.get("phone") ?? "",
    });

    return successResponse(await checkResidentPhone(principal.userId, phone), "Phone checked");
  } catch (error) {
    return handleRouteError(error);
  }
}
