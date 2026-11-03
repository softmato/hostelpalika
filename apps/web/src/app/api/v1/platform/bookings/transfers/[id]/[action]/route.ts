import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  markTransferSent,
  revealTransferDestination,
} from "@/modules/bookings/booking-transfer.service";

type RouteContext = { params: Promise<{ action: string; id: string }> };

export const runtime = "nodejs";

/**
 * `sent` — `{ transactionId, proofAssetId?, note? }` once the money has gone.
 * `reveal` — the full account number to type into the banking app. Audited.
 */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const { action, id } = await context.params;

    if (action === "sent") {
      const transfer = await markTransferSent(id, await request.json(), principal);

      return successResponse({ transfer }, "Marked sent.");
    }

    if (action === "reveal") {
      // A full account number is never cached (P7-33).
      return successResponse(await revealTransferDestination(id, principal), "Account number", {
        headers: { "cache-control": "no-store" },
      });
    }

    return new Response("Not found", { status: 404 });
  } catch (error) {
    return handleRouteError(error);
  }
}
