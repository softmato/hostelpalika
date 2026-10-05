import type { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { validateCronRequest } from "@/lib/cron-auth";
import {
  periodOf,
  runBillingCycleForAllHostels,
} from "@/modules/finance/billing.service";
import { accrueLateFines } from "@/modules/finance/late-fine.service";

export const runtime = "nodejs";
/** Every hostel, every resident, priced then written. 60s is the ceiling here. */
export const maxDuration = 60;

/**
 * Cron: issue the month's invoices for every hostel (target §6.1, plan §9).
 *
 * Daily, just after Nepal midnight — see `docs/CRON.md`. A BS month has no fixed
 * Gregorian start, so only a daily run bills it on its first day. Idempotent: the
 * double-billing index makes a second run a no-op, so a retried or
 * double-scheduled invocation cannot bill anyone twice.
 *
 * **The response body is the run record, and it is meant to be read.** Hostels
 * that could not be billed come back as rows carrying their error code — a
 * hostel with no fee schedule is a real, expected outcome (§7.3) and must not be
 * silently absent. The current dunning cron's stats go nowhere, which is why a
 * silently failing job is invisible (current §5.6); this does not repeat that.
 *
 * Auth: `x-cron-secret` (or `Authorization: Bearer <CRON_SECRET>`) header only.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = validateCronRequest(request);

    if (!auth.ok) {
      return errorResponse(
        auth.error,
        auth.status === 401 ? "UNAUTHORIZED" : "CRON_NOT_CONFIGURED",
        auth.status,
      );
    }

    const period =
      new URL(request.url).searchParams.get("period") ?? periodOf(new Date());
    const hostels = await runBillingCycleForAllHostels(period);
    // Daily, after billing: bring every late bill's fine up to today.
    const lateFines = await accrueLateFines();

    return successResponse(
      {
        failedHostels: hostels.filter((hostel) => hostel.errorCode),
        hostels,
        invoicesIssued: hostels.reduce((sum, hostel) => sum + hostel.billedCount, 0),
        lateFines,
        period,
        totalBilled: hostels.reduce((sum, hostel) => sum + hostel.totalBilled, 0),
      },
      "Billing cycle processed",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
