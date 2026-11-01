import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getSavedHostelIds, updateSavedHostelIds } from "@/modules/users/saved-hostels.service";

export const runtime = "nodejs";

const bodySchema = z.object({
  add: z.array(z.string().max(40)).max(200).optional(),
  remove: z.array(z.string().max(40)).max(200).optional(),
});

/** The hostels this account has hearted. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);

    return successResponse({ ids: await getSavedHostelIds(principal.userId) }, "Saved hostels loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Add and/or remove hearts. Also how a browser's anonymous hearts are bound at login. */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireApiPrincipal(request);
    const input = bodySchema.parse(await request.json());

    return successResponse({ ids: await updateSavedHostelIds(principal.userId, input) }, "Saved hostels updated");
  } catch (error) {
    return handleRouteError(error);
  }
}
