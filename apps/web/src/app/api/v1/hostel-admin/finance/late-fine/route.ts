import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { getLateFine, lateFineSaveSchema, saveLateFine } from "@/modules/finance/late-fine.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/** The hostel's late-fine rule. Read with `viewPayments`, changed like a rate. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewPayments");
    const hostelId = resolveAdminHostelId(
      principal,
      request.nextUrl.searchParams.get("hostelId") ?? undefined,
    );

    return successResponse({ lateFine: await getLateFine(hostelId) }, "Late fine");
  } catch (error) {
    return handleRouteError(error);
  }
}

export async function PUT(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageFeeSchedule");
    const input = lateFineSaveSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(
      {
        lateFine: await saveLateFine(
          hostelId,
          { enabled: input.enabled, graceDays: input.graceDays, mode: input.mode, rate: input.rate },
          principal,
        ),
      },
      "Late fine saved",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
