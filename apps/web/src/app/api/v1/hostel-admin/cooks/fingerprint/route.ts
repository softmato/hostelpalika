import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { setCookFingerprintLock } from "@/modules/food/cook-roster.service";
import { cookExpensesSchema } from "@/modules/finance/expenses/expense.validation";

export const runtime = "nodejs";

/** The owner asks cooks to lock the app with a fingerprint, or stops asking. Off by default. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    // Same `{ enabled, hostelId? }` body as the cook's expense switch.
    const input = cookExpensesSchema.parse(await request.json());

    return successResponse(
      await setCookFingerprintLock(principal, input.enabled, input.hostelId),
      input.enabled ? "Cooks will be asked for a fingerprint" : "Cooks are no longer asked",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
