import crypto from "node:crypto";

import { errorResponse } from "@/lib/api-response";

const HEADER = "x-questioncall-secret";

function safeEqual(a: string, b: string) {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");

  // timingSafeEqual throws on a length mismatch, so compare lengths first.
  if (bufA.length === 0 || bufA.length !== bufB.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * The shared secret QuestionCall's backend sends on every call to us, in a
 * header (never a query param, which would land in access logs). Same contract
 * as the cron endpoints. Returns the error response, or null when it matches.
 */
export function questionCallSecretError(request: Request) {
  const configured = process.env.QUESTIONCALL_WEBHOOK_SECRET?.trim();

  if (!configured) {
    return errorResponse(
      "QuestionCall webhook is not configured.",
      "INTEGRATION_NOT_CONFIGURED",
      503,
    );
  }

  const provided = request.headers.get(HEADER)?.trim() ?? "";

  return safeEqual(provided, configured)
    ? null
    : errorResponse("Unauthorized", "UNAUTHENTICATED", 401);
}
