import type { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { buildFormPostHandoff, HandoffError } from "@/modules/finance/gateway/handoff.service";

export const runtime = "nodejs";

const STATUS: Record<HandoffError["reason"], number> = { EXPIRED: 410, NOT_FORM_POST: 409, NOT_FOUND: 404, NOT_PAYABLE: 409 };

/**
 * The signed eSewa form behind `/pay/[reference]` (PARITY §9: the relay page
 * reads the API). No session, by design — `buildFormPostHandoff` bounds it:
 * `CREATED` and unexpired only, and nothing in it but an amount and a merchant form.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ reference: string }> }) {
  try {
    const { reference } = await params;

    return successResponse({ handoff: await buildFormPostHandoff(reference) }, "Payment hand-off ready");
  } catch (error) {
    if (error instanceof HandoffError) {
      return errorResponse(error.message, `HANDOFF_${error.reason}`, STATUS[error.reason]);
    }

    return handleRouteError(error);
  }
}
