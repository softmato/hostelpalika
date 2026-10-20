import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import {
  feeScheduleListQuerySchema,
  rentConcessionSaveSchema,
} from "@/modules/finance/fee-schedule.validation";
import {
  listRentConcessions,
  saveRentConcession,
} from "@/modules/finance/rent-concession.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

/**
 * Months the hostel has discounted — Dashain at half rent and its like.
 *
 * Behind the same two capabilities as the rate card it sits on top of:
 * `viewPayments` to read, `manageFeeSchedule` to change. A warden who may not
 * set a rent may not halve one either, which is the same decision by a different
 * route.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewPayments");
    const query = feeScheduleListQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );

    return withEtag(request, successResponse(
      {
        concessions: await listRentConcessions(
          resolveAdminHostelId(principal, query.hostelId),
        ),
      },
      "Month discounts",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * Sets the discount for one month, replacing any already on it.
 *
 * A POST that upserts rather than a PUT on an id, because the thing being named
 * is the **month**: there is one discount per month by index, and "make Dashain
 * 40 instead of 50" is a correction to one fact. Unlike a rate card there is no
 * history to keep — invoices already issued carry the figure they were computed
 * from and this never rewrites them.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageFeeSchedule");
    const input = rentConcessionSaveSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    return successResponse(
      {
        concession: await saveRentConcession(
          hostelId,
          { percentOff: input.percentOff, period: input.period, reason: input.reason },
          principal,
        ),
      },
      "Month discount saved",
      { status: 201 },
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
