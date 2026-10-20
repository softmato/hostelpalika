import type { NextRequest } from "next/server";

import { requireSuperadminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getBookingConfig, mergeBookingConfig } from "@/modules/bookings/booking-config";
import {
  getPendingSettingChange,
  requestSettingChange,
} from "@/modules/platform-config/setting-change.service";

export const runtime = "nodejs";

/**
 * The booking terms, and the edit waiting on an email confirm if there is one.
 * Superadmin only.
 */
export async function GET(request: NextRequest) {
  try {
    await requireSuperadminPrincipal(request);

    const [config, pending] = await Promise.all([
      getBookingConfig(),
      getPendingSettingChange("bookings"),
    ]);

    return withEtag(request, successResponse({ config, pending }, "Booking settings loaded"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Asks for a change. Nothing is saved here: the merged terms are validated as a
 * whole and a confirm link goes to the superadmin's own email.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireSuperadminPrincipal(request);
    const proposed = mergeBookingConfig(await getBookingConfig(), await request.json());
    const pending = await requestSettingChange("bookings", proposed, principal);

    return successResponse(
      { pending },
      `Check your email. We sent a confirm link to ${pending.sentTo}.`,
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
