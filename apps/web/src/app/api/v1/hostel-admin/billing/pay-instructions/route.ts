import type { NextRequest } from "next/server";

import { requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getPlanPaymentInstructions } from "@/modules/billing/subscription-claim.service";

export const runtime = "nodejs";

/**
 * How this hostel pays us: the amount, the invoice to quote, and our QR.
 *
 * The owner-facing twin of `/team/collection-qr`, which shows a field agent the
 * same image. It carries more than the QR because the person reading it is the
 * payer rather than the collector — they need to know how much, against which
 * invoice, and whether a claim they already sent is still being looked at.
 *
 * Admin rather than staff. Every other read under `hostel-admin/billing` is a
 * history a warden may legitimately see; this one is the screen money is sent
 * from, and committing the hostel to a plan payment is not a warden's act.
 *
 * Scoped to the principal's first hostel rather than taking one from the query
 * string, exactly as the endpoints beside it are — an id in the URL would be an
 * endpoint that hands one hostel's balance to another hostel's staff.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const hostelId = principal.hostelIds?.[0];

    if (!hostelId) {
      return withEtag(request, successResponse(
        {
          instructions: {
            amountDue: 0,
            claim: null,
            dueBy: null,
            invoice: null,
            overdue: false,
            qr: null,
            reference: null,
          },
        },
        "No hostel in scope",
      ));
    }

    return withEtag(request, successResponse(
      { instructions: await getPlanPaymentInstructions(hostelId) },
      "Payment instructions loaded",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
