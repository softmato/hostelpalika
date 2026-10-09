import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError, successResponse } from "@/lib/api-response";
import { Role } from "@/lib/roles";
import { getHostelLedger } from "@/modules/finance/invoice-list.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";

const querySchema = z.object({
  hostelId: z.string().optional(),
});

/**
 * The hostel's whole transaction ledger, newest first.
 *
 * Separate from `GET /finance/invoices` on purpose: that route is the month
 * matrix — one row per resident for one period — and the Transactions screen
 * wants every invoice this hostel has ever raised, including the one-off
 * admission fees that belong to no period and so appear in no month of the
 * matrix. The screen used to call the matrix route and read a `payments` key it
 * never returned, which is why the table was permanently empty.
 *
 * **Reads never bill.** Same rule as the matrix.
 *
 * It also carries the recorded expenses (all for the owner, a warden's own for
 * a warden), so the statement shows money out (debits) beside money in.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewPayments");
    const query = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const hostelId = resolveAdminHostelId(principal, query.hostelId);

    // Expenses ride along so the statement shows debits too — every one for the
    // owner, and for a warden the rows they added or were handed, the same line
    // the expenses screen draws.
    const expensesFor = principal.userId;
    const expensesMineOnly = principal.role !== Role.HOSTEL_ADMIN;

    return successResponse(await getHostelLedger(hostelId, { expensesFor, expensesMineOnly }), "Transactions");
  } catch (error) {
    return handleRouteError(error);
  }
}
