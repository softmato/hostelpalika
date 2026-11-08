import type { NextRequest } from "next/server";

import { requireResidentPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { submitClaim } from "@/modules/finance/claim.service";
import { claimSubmitSchema } from "@/lib/finance/claim.validation";

export const runtime = "nodejs";

/**
 * A resident claiming they have paid (target §11.2, plan item 2.8).
 *
 * Replaces `POST /api/v1/resident/payments/[paymentId]/proof`. A replayed submit
 * returns `200` rather than a second `201`: the idempotency key collapsed it to
 * the claim that already exists, and telling the resident "created" twice would
 * be a lie about what happened.
 *
 * **Rate-limited, and this one is about cost rather than guessing** (item E.8).
 * Every POST here can run sharp and tesseract over a full-size screenshot, which
 * is seconds of CPU — so a script looping on submit is a denial of service with
 * no forged credential and nothing to brute-force. The budget is deliberately
 * small: a resident pays rent once a month and re-uploads a blurry screenshot two
 * or three times at worst, so anything above a handful an hour is not a person.
 *
 * Applied before the body is parsed and before the principal is resolved, because
 * work done ahead of the limiter is work an attacker gets for free.
 */
const CLAIM_SUBMIT_LIMIT = 8;
const CLAIM_SUBMIT_WINDOW_MS = 60 * 60 * 1000;

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const limited = rateLimitPublicForm(request, {
      limit: CLAIM_SUBMIT_LIMIT,
      namespace: "resident-claim-submit",
      windowMs: CLAIM_SUBMIT_WINDOW_MS,
    });

    if (limited) {
      return limited;
    }

    const principal = await requireResidentPrincipal(request);
    const { id } = await context.params;
    const input = claimSubmitSchema.parse(await request.json());

    const result = await submitClaim(id, input, principal);

    return successResponse(
      result,
      result.created ? "Payment proof submitted" : "This proof was already submitted",
      { status: result.created ? 201 : 200 },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
