import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError } from "@/lib/api-response";
import { downloadBackupFile } from "@/modules/backup/backup.service";

export const runtime = "nodejs";
export const maxDuration = 120;

/** The encrypted backup file, streamed from the owner's Drive (I6 download, I7 restore). */
export async function GET(request: NextRequest, context: { params: Promise<{ runId: string }> }) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;
    const { runId } = await context.params;
    const file = await downloadBackupFile(principal, hostelId, runId);
    const headers = new Headers({
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${file.fileName}"`,
      "content-type": "application/octet-stream",
      "x-backup-sha512": file.sha512,
    });

    if (file.bytes) headers.set("content-length", String(file.bytes));

    return new Response(file.body, { headers });
  } catch (error) {
    return handleRouteError(error);
  }
}
