import type { NextRequest } from "next/server";
import { z } from "zod";

import { requireHostelCapability } from "@/lib/api-auth";
import { handleRouteError } from "@/lib/api-response";
import { currentBsPeriod } from "@/lib/hostel-day";
import { Role } from "@/lib/roles";
import { getHostelLedger } from "@/modules/finance/invoice-list.service";
import { resolveAdminHostelId } from "@/modules/hostels/hostel.service";
import {
  buildStatement,
  isStatementPeriod,
  renderStatementPdf,
  statementPdfFilename,
} from "@/modules/reports/statement-pdf";
import { HostelModel } from "@hostel/db/models/Hostel";

export const runtime = "nodejs";

const period = z.string().refine(isStatementPeriod, "Use a BS month, YYYY-MM.");

const querySchema = z.object({
  from: period.optional(),
  hostelId: z.string().optional(),
  to: period.optional(),
});

/**
 * The hostel statement between two BS months as a bank-style PDF — every
 * credit (rent received) and, for the owner, every debit (expense recorded),
 * numbered, with a running balance and the totals under it.
 *
 * Same read and the same rule as `finance/invoices/ledger`: `viewPayments`,
 * and expenses only for the owner. Both ends default to this month.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelCapability(request, "viewPayments");
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
    const hostelId = resolveAdminHostelId(principal, query.hostelId);
    const expensesFor = principal.role === Role.HOSTEL_ADMIN ? principal.userId : undefined;
    const thisMonth = currentBsPeriod();

    const [ledger, hostel] = await Promise.all([
      getHostelLedger(hostelId, { expensesFor }),
      HostelModel.findById(hostelId).select("name").lean<{ name?: string } | null>(),
    ]);
    const statement = buildStatement(ledger, query.from ?? thisMonth, query.to ?? query.from ?? thisMonth);
    const bytes = await renderStatementPdf(statement, hostel?.name ?? "");

    return new Response(bytes as BodyInit, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${statementPdfFilename(statement.from, statement.to)}"`,
        "content-type": "application/pdf",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
