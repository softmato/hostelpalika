import type { NextRequest } from "next/server";

import { loadApiPrincipal, requireApiPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimitPublicForm } from "@/lib/rate-limit";
import { joinRequestSchema } from "@/modules/residents/existing-residents.validation";
import { getJoinPage, sendJoinRequest } from "@/modules/residents/resident-join.service";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ token: string }> };

/**
 * A hostel's join link, as the person opening it sees it. Signed out it shows
 * the hostel and its rooms; signed in it adds their ID card and their own
 * request. Rate limited: the token is the only thing standing between a
 * stranger and the hostel's name.
 */
export async function GET(request: NextRequest, context: RouteContext) {
  try {
    const limited = rateLimitPublicForm(request, { limit: 60, namespace: "join-link-read" });

    if (limited) return limited;

    const { token } = await context.params;
    const principal = await loadApiPrincipal(request);

    return successResponse(await getJoinPage(token, principal?.userId ?? null), "Join link loaded");
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Send the request, or send it again after a fix — always the same request. */
export async function POST(request: NextRequest, context: RouteContext) {
  try {
    const limited = rateLimitPublicForm(request, { limit: 12, namespace: "join-link-send" });

    if (limited) return limited;

    const principal = await requireApiPrincipal(request);
    const { token } = await context.params;
    const input = joinRequestSchema.parse(await request.json());

    return successResponse(await sendJoinRequest(token, input, principal.userId), "Request sent");
  } catch (error) {
    return handleRouteError(error);
  }
}
