import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { restoreBackupChunk } from "@/modules/backup/backup.service";

export const runtime = "nodejs";

const chunkSchema = z.object({
  collection: z.string().min(1).max(60),
  data: z.string().min(2),
  index: z.number().int().min(0),
  runId: z.string().min(1),
});

/** One chunk of a backup the owner's phone decrypted (I7). Adds missing rows only. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;
    const input = chunkSchema.parse(await request.json());

    return successResponse(await restoreBackupChunk(principal, hostelId, input), "Restored");
  } catch (error) {
    return handleRouteError(error);
  }
}
