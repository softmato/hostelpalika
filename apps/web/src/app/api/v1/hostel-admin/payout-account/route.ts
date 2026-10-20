import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  getHostelPayoutAccount,
  setHostelPayoutAccount,
} from "@/modules/bookings/payout-account.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/**
 * Where HostelPalika sends this hostel's booking payouts. Masked on the way out.
 *
 * Owner-only both ways: a warden who can approve rent proofs has no business
 * deciding which account the platform pays.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const hostelId = resolveAdminHostelId(
      principal,
      request.nextUrl.searchParams.get("hostelId") ?? undefined,
    );

    return withEtag(request, successResponse(
      { account: await getHostelPayoutAccount(hostelId) },
      "Payout account",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Sets or changes it. Every change goes back to review and emails the admins. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const body = (await request.json()) as Record<string, unknown>;
    const hostelId = resolveAdminHostelId(
      principal,
      typeof body.hostelId === "string" ? body.hostelId : undefined,
    );

    const account = await setHostelPayoutAccount(String(hostelId), body, {
      source: "HOSTEL_ADMIN",
      userId: principal.userId,
    });

    return successResponse({ account }, "Payout account saved. We will check it before any payout.");
  } catch (error) {
    return handleRouteError(error);
  }
}
