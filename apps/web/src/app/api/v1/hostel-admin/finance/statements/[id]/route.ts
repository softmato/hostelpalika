import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getReconciliation } from "@/modules/finance/statements/reconcile.service";

export const runtime = "nodejs";

/**
 * The three buckets of one import (target §11.5).
 *
 * Scoped to the caller's hostels inside the service, so an id from another
 * tenant answers 404 exactly as a non-existent one does (RULES.md §3).
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const principal = await requireHostelCapability(request, "approvePayments");
    const { id } = await context.params;

    return withEtag(request, successResponse(
      await getReconciliation(id, principal.hostelIds),
      "Reconciliation",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
