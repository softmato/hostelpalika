import type { NextRequest } from "next/server";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import {
  getBillingPeriodSummary,
  runBillingCycle,
} from "@/modules/finance/billing.service";
import {
  billingRunQuerySchema,
  billingRunSchema,
} from "@/modules/finance/billing.validation";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import { notifyInvoicesRaised } from "@/modules/finance/finance-notify";

export const runtime = "nodejs";
/** A large roster prices every resident before writing; the default is tight. */
export const maxDuration = 60;

/**
 * The billing run (target §6.1, plan item 2.5).
 *
 * `manageFeeSchedule`, not `viewPayments`: issuing a month of invoices is the
 * same authority as setting the rates they are computed from, and item 0.5 split
 * these apart precisely so proof verification does not carry it.
 */
export async function POST(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "manageFeeSchedule");
    const input = billingRunSchema.parse(await request.json());
    const hostelId = resolveAdminHostelId(principal, input.hostelId);

    const result = await runBillingCycle(
      {
        dueDate: input.dueDate,
        hostelId,
        period: input.period,
        residentIds: input.residentIds,
      },
      principal,
    );

    await notifyInvoicesRaised({ billed: result.billed, hostelId, period: input.period });

    // 200, not 201: a re-run that creates nothing is a success, and it is the
    // common case. The counts in the body say what happened.
    return successResponse(result, `Billed ${result.billed.length} residents`);
  } catch (error) {
    return handleRouteError(error);
  }
}

/** What the period looks like now. Reads never bill — that is the whole item. */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewPayments");
    const query = billingRunQuerySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const hostelId = resolveAdminHostelId(principal, query.hostelId);

    return successResponse(
      await getBillingPeriodSummary(hostelId, query.period),
      "Billing period summary",
    );
  } catch (error) {
    return handleRouteError(error);
  }
}
