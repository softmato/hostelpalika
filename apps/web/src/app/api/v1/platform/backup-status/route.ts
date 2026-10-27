import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getPlatformBackupStatus } from "@/modules/backup/platform-backup.service";

export const runtime = "nodejs";

/** The superadmin dashboard's backup row (docs/BACKUP.md I2). */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    return successResponse(await getPlatformBackupStatus(), "Backup status loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}
