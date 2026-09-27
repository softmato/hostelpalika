import type { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { validateCronRequest } from "@/lib/cron-auth";
import { raiseDueRenewals } from "@/modules/billing/plan-renewal-sweep.service";
import { runPaymentReminders } from "@/modules/finance/dunning.service";
import { sendAdminPaymentDigest } from "@/modules/finance/finance-notify";

export const runtime = "nodejs";
// Emails are external I/O; a large hostel roster needs more than the default.
export const maxDuration = 60;

/**
 * Cron: daily payment reminders and overdue chases (PHASES.md §3.1).
 * Idempotent within a day — reminders fire on an exact day offset from the due
 * date, overdue chases on a decaying schedule.
 *
 * Then the hostel admins' one payments email of the day
 * (`sendAdminPaymentDigest`).
 *
 * Residents' rent only. Plan payment reminders, and the resident fee pushes,
 * are automatic rows on the superadmin Push tab, sent by `platform-push`.
 *
 * First, each plan ending within a week gets its next bill
 * (`raiseDueRenewals`), so the 08:00 plan reminders have it to remind about.
 *
 * Auth: `x-cron-secret` (or `Authorization: Bearer <CRON_SECRET>`) header only.
 * Scheduled via cron-job.org with a POST request — see `docs/CRON.md`.
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

    const renewals = await raiseDueRenewals();
    const reminders = await runPaymentReminders();
    const digest = await sendAdminPaymentDigest();

    return successResponse({ ...reminders, digest, renewals }, "Payment reminders processed");
  } catch (error) {
    return handleRouteError(error);
  }
}
