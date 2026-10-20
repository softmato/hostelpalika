import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getMoneyRules, moneyRulesSchema, saveMoneyRules } from "@/modules/finance/money-rules.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/** Opening balance, the leaving-month rule and the days-away rule. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewPayments");
    const hostelId = resolveAdminHostelId(principal, request.nextUrl.searchParams.get("hostelId") ?? undefined);

    return withEtag(request, successResponse({ rules: await getMoneyRules(hostelId) }, "Money rules"));
  } catch (error) {
    return handleRouteError(error);
  }
}

/** Changed like a rate: these decide what residents are charged. */
export async function PUT(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageFeeSchedule");
    const input = moneyRulesSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse({ rules: await saveMoneyRules(hostelId, input, principal) }, "Saved");
  } catch (error) {
    return handleRouteError(error);
  }
}
