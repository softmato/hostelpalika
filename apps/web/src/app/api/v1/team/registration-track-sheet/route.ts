import type { NextRequest } from "next/server";

import { requireTeamPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { trackSheetSaveSchema } from "@/modules/team/registration-track-sheet";
import { getTrackSheet, saveTrackSheet } from "@/modules/team/registration-track-sheet.service";

export const runtime = "nodejs";

/** Every agreement signed, for `/hostel-registration-track-sheet`. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireTeamPrincipal(request);

    return withEtag(request, successResponse(await getTrackSheet(principal), "Track sheet loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Saves the changed lines; new ones get their ref codes here, never from the browser. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireTeamPrincipal(request);
    const input = trackSheetSaveSchema.parse(await request.json());

    return successResponse(await saveTrackSheet(input, principal), "Track sheet saved");
  } catch (error) {
    return handleRouteError(error);
  }
}
