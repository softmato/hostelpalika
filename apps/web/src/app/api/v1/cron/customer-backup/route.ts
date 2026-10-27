import type { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { validateCronRequest } from "@/lib/cron-auth";
import { runScheduledBackups } from "@/modules/backup/backup.service";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Cron: each connected hostel's daily encrypted backup to its own Google Drive
 * (docs/FIELD_REVIEW_2026_10_27.md I5). Hostels not backed up in 20 hours, oldest
 * first; what does not fit in one run goes in the next, so schedule it hourly.
 *
 * Auth: `x-cron-secret` header, like every cron — see `docs/CRON.md`.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = validateCronRequest(request);

    if (!auth.ok) {
      return errorResponse(auth.error, auth.status === 401 ? "UNAUTHORIZED" : "CRON_NOT_CONFIGURED", auth.status);
    }

    return successResponse(await runScheduledBackups(), "Customer backups run");
  } catch (error) {
    return handleRouteError(error);
  }
}
