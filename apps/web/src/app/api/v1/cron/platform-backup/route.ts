import type { NextRequest } from "next/server";

import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { validateCronRequest } from "@/lib/cron-auth";
import { platformBackupReportSchema, recordPlatformBackupReport } from "@/modules/backup/platform-backup.service";

export const runtime = "nodejs";

/**
 * The platform backup reporting in (docs/BACKUP.md): the nightly workflow posts
 * its manifest (`BACKUP`), the owner's restore drill posts its result (`DRILL`).
 * Counts and a hash only — never data, never a key.
 *
 * Auth: `x-cron-secret`, like every cron route.
 */
export async function POST(request: NextRequest) {
  try {
    const auth = validateCronRequest(request);

    if (!auth.ok) {
      return errorResponse(auth.error, auth.status === 401 ? "UNAUTHORIZED" : "CRON_NOT_CONFIGURED", auth.status);
    }

    await recordPlatformBackupReport(platformBackupReportSchema.parse(await request.json()));

    return successResponse({ recorded: true }, "Backup report recorded");
  } catch (error) {
    return handleRouteError(error);
  }
}
