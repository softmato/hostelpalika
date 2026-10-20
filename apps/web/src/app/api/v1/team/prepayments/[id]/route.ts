import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireTeamPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";

import { readTeamPrepayment, saveTeamPrepaymentDraft } from "@/modules/team/team-prepayment.service";

type RouteContext = { params: Promise<{ id: string }> };

export const runtime = "nodejs";

/** Where one of this agent's pre-publish payments stands, asked of Softmato while it is open. */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireTeamPrincipal(request);
    const { id } = await context.params;

    return withEtag(request, successResponse(await readTeamPrepayment(id, principal), "Payment read"));
  } catch (error) {
    return handleRouteError(error);
  }
}

const draftBody = z.object({ draft: z.record(z.string(), z.unknown()) });

/** Keeps the form's latest state on a paid row, so it reopens from the desk as it was left. */
export async function PATCH(request: NextRequest, context: RouteContext) {
  try {
    const principal = await requireTeamPrincipal(request);
    const { id } = await context.params;
    const { draft } = draftBody.parse(await request.json());

    await saveTeamPrepaymentDraft(id, principal, draft);

    return successResponse({ saved: true }, "Draft kept");
  } catch (error) {
    return handleRouteError(error);
  }
}
