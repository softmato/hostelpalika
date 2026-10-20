import type { NextRequest } from "next/server";

import { requirePlatformPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { listFieldCashToConfirm, SOFTMATO_CASH_QUEUE_URL } from "@/modules/billing/cash-filing.service";

export const runtime = "nodejs";

/** Cash field agents collected that is waiting on a Softmato admin to confirm it. */
export async function GET(request: NextRequest) {
  try {
    await requirePlatformPrincipal(request);

    return withEtag(request, successResponse(
      { cash: await listFieldCashToConfirm(), confirmUrl: SOFTMATO_CASH_QUEUE_URL },
      "Cash to confirm loaded",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
