import { csvFilename, csvResponse, toCsv } from "@/lib/csv";
import type { ReportExport } from "@/modules/reports/report-export.service";
import { renderReportPdf } from "@/modules/reports/report-pdf";

/**
 * Turns a built report into whichever file the caller asked for.
 *
 * Both export routes — the hostel admin's four and the platform's four — do the
 * identical thing with their `ReportExport`, so the branch lives here rather
 * than twice. That matters more than it looks: a format added to one route and
 * not the other is exactly the drift that leaves an owner able to download a PDF
 * and a superadmin unable to.
 */

/** `collection-2026-08-26.pdf`. Mirrors `csvFilename`, which owns the CSV case. */
function pdfFilename(prefix: string, date = new Date()) {
  return `${prefix}-${date.toISOString().slice(0, 10)}.pdf`;
}

/** `residents-over-time` → `Residents over time`. */
function titleFrom(prefix: string): string {
  const words = prefix.split("-").filter(Boolean);

  if (words.length === 0) {
    return "Report";
  }

  return `${words[0].charAt(0).toUpperCase()}${words[0].slice(1)}${
    words.length > 1 ? ` ${words.slice(1).join(" ")}` : ""
  }`;
}

export async function reportExportResponse(
  report: ReportExport,
  {
    format,
    scopeName = "",
  }: { format: "csv" | "pdf"; scopeName?: string },
): Promise<Response> {
  if (format === "csv") {
    return csvResponse(
      toCsv(report.columns, report.rows),
      csvFilename(report.filenamePrefix),
    );
  }

  const bytes = await renderReportPdf({
    columns: report.columns,
    generatedAt: new Date(),
    period: report.period,
    rows: report.rows,
    scopeName,
    title: titleFrom(report.filenamePrefix),
  });

  return new Response(bytes as BodyInit, {
    headers: {
      /*
       * `no-store`, the same as the CSV path. A report is a snapshot of live
       * figures and a cached copy served tomorrow would be quietly wrong — and
       * these carry hostel-scoped data that has no business in a shared proxy.
       */
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${pdfFilename(report.filenamePrefix)}"`,
      "content-type": "application/pdf",
    },
  });
}
