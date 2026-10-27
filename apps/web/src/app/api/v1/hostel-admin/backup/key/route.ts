import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { confirmRecoveryKit, setBackupKey } from "@/modules/backup/backup.service";

export const runtime = "nodejs";

/** The public half of the recovery key, made on the owner's phone. The private half never comes here. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;
    const { publicKey } = z.object({ publicKey: z.string().min(40).max(60) }).parse(await request.json());

    return successResponse(await setBackupKey(principal, hostelId, publicKey), "Recovery key saved");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** The recovery kit for this key is saved. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const hostelId = request.nextUrl.searchParams.get("hostelId") ?? undefined;
    const { fingerprint } = z.object({ fingerprint: z.string().min(4).max(40) }).parse(await request.json());

    await confirmRecoveryKit(principal, hostelId, fingerprint);

    return successResponse({ confirmed: true }, "Recovery kit noted");
  } catch (error) {
    return handleRouteError(error);
  }
}
