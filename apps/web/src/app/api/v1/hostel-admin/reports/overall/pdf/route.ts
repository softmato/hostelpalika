import type { NextRequest } from "next/server";
import { z } from "zod";

import { type ApiPrincipal, requireHostelAdminPrincipal } from "@/lib/api-auth";
import { handleRouteError } from "@/lib/api-response";
import { currentBsPeriod, isBsPeriod } from "@/lib/hostel-day";
import { getHostelLedger } from "@/modules/finance/invoice-list.service";
import { getBranchesSummary } from "@/modules/hostels/hostel-branch.service";
import {
  type OverallBranchFigures,
  overallPdfFilename,
  overallTable,
  renderOverallPdf,
} from "@/modules/reports/overall-pdf";
import { renderPerformanceReportPdf } from "@/modules/reports/performance-report-pdf";
import { getHostelPerformanceReport } from "@/modules/reports/performance-report.service";
import { buildStatement, renderStatementPdf } from "@/modules/reports/statement-pdf";

export const runtime = "nodejs";

const querySchema = z.object({
  kind: z.enum(["report", "statement"]).default("report"),
  month: z.string().trim().optional(),
});

/**
 * Every branch the owner runs, in one PDF — the Overall view's download. A
 * cover with one row per branch (collection, dues, spending, the cash their
 * wardens hold), then each branch's own report or statement.
 *
 * Owner only. Each branch is read with a principal narrowed to that one
 * branch, the same narrowing the switcher's header gets, so no branch's pages
 * can carry another's rows.
 */
export async function GET(request: NextRequest) {
  try {
    const principal = await requireHostelAdminPrincipal(request);
    const query = querySchema.parse(Object.fromEntries(request.nextUrl.searchParams.entries()));
    const current = currentBsPeriod();
    const month = query.month && isBsPeriod(query.month) && query.month <= current ? query.month : current;
    const summary = await getBranchesSummary(principal);
    const figures: OverallBranchFigures[] = [];
    const parts: Uint8Array[] = [];

    // One branch at a time: each is a full report, and a few at once is a spike nobody needs.
    for (const branch of summary.hostels) {
      const scoped: ApiPrincipal = { ...principal, hostelIds: [branch.id] };
      const ledger = await getHostelLedger(branch.id, { expensesFor: principal.userId });
      const statement = buildStatement(ledger, month, month);
      const staffCash = statement.staff.reduce((sum, line) => sum + line.left, 0);
      let collected = branch.collected;
      let due = branch.due;

      if (query.kind === "report") {
        const report = await getHostelPerformanceReport({ month }, scoped);

        collected = report.finance.collected;
        due = report.finance.outstanding;
        parts.push(await renderPerformanceReportPdf(report));
      } else {
        parts.push(await renderStatementPdf(statement, branch.name));
      }

      figures.push({
        closing: statement.closing,
        collected,
        due,
        isBranch: branch.isBranch,
        moneyIn: statement.totals.credit,
        moneyOut: statement.totals.debit,
        name: branch.name,
        residents: branch.residents,
        staffCash,
      });
    }

    const bytes = await renderOverallPdf({
      kind: query.kind,
      parts,
      period: month,
      table: overallTable(query.kind, figures),
    });

    return new Response(bytes as BodyInit, {
      headers: {
        "cache-control": "no-store",
        "content-disposition": `attachment; filename="${overallPdfFilename(query.kind, month)}"`,
        "content-type": "application/pdf",
      },
    });
  } catch (error) {
    return handleRouteError(error);
  }
}
