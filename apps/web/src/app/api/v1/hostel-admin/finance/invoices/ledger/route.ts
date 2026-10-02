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
 * For the owner it also carries the hostel's recorded expenses, so the
 * statement shows money out (debits) beside money in.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewPayments");
    const query = querySchema.parse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    const hostelId = resolveAdminHostelId(principal, query.hostelId);

    // Expenses ride along for the owner only — the same line the expenses
    // screen draws, where a warden sees just the rows they added themselves.
    const expensesFor = principal.role === Role.HOSTEL_ADMIN ? principal.userId : undefined;

    return successResponse(await getHostelLedger(hostelId, { expensesFor }), "Transactions");
  } catch (error) {
    return handleRouteError(error);
  }
}
