import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { withEtag } from "@/lib/etag";
import { getInvoiceMatrix } from "@/modules/finance/invoice-list.service";
import { periodOf } from "@/modules/finance/billing.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

const querySchema = z.object({
  hostelId: z.string().optional(),
  period: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
});

/**
 * One row per resident for a period, billed or not (plan item 2.8).
 *
 * Replaces both `GET /payments` and `GET /payments/matrix`. **Reads never bill**
 * — the matrix used to create an invoice for every unbilled resident as a side
 * effect of rendering, which is the defect item 2.5 removed.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewPayments");
    const query = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const hostelId = resolveAdminHostelId(principal, query.hostelId);

    return withEtag(request, successResponse(
      await getInvoiceMatrix(hostelId, query.period ?? periodOf(new Date())),
      "Invoices",
    ));
  } catch (error) {
    return handleRouteError(error);
  }
}
