import type { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm, rateLimitSubject } from "@/lib/rate-limit";
import { AuthServiceError, requestPasswordReset } from "@/modules/auth/auth.service";
import { forgotPasswordSchema } from "@hostel/shared/schemas/auth.schema";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  try {
    const limited = rateLimitPublicForm(request, {
      limit: 5,
      namespace: "auth-forgot-password",
      windowMs: 15 * 60 * 1000,
    });

    if (limited) {
      return limited;
    }

    const input = forgotPasswordSchema.parse(await request.json());
    // Per inbox, whichever IPs ask: rotating proxies otherwise mail-bombed any address.
    const perAddress = rateLimitSubject("auth-forgot-password-to", input.email, 3, 60 * 60 * 1000);
    if (perAddress) return perAddress;
    const result = await requestPasswordReset(input);

    return successResponse(
      result,
      "A reset link has been sent.",
    );
  } catch (error) {
    if (error instanceof AuthServiceError) {
      return errorResponse(error.message, error.errorCode, error.status);
    }

    return handleRouteError(error);
  }
}
