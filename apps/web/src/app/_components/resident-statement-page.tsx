"use client";

import { formatBsPeriod, formatHostelDate } from "@hostel/shared/calendar/bs";
import { useMemo } from "react";

import { StatementExportButton, StatementView } from "@/components/statement/statement-view";
import { downloadTable } from "@/lib/downloads/downloader";
import { usePortalResource } from "@/lib/portal-query";
import { type StatementRow, withBalances } from "@/lib/statement";

import { currency } from "./shared-ui";

/**
 * A resident's own statement on the web — the app's `(resident)/statement`:
 * every payment they have made to the hostel, newest first, grouped by day,
 * with the total paid so far. Same layout as the hostel's (`StatementView`).
 */

type Invoice = {
  dueAmount: number;
  dueDate?: string;
  id: string;
  method?: string;
  month: string | null;
  paidAmount: number;
  paidDate?: string;
  referenceCode?: string | null;
  status: string;
};

const humanize = (value: string) => value.charAt(0) + value.slice(1).toLowerCase().replaceAll("_", " ");

function toRows(invoices: Invoice[]): StatementRow[] {
  const rows = invoices
    .filter((invoice) => invoice.paidAmount > 0)
    .map((invoice): StatementRow => {
      const method = (invoice.method ?? "OTHER").trim() || "OTHER";
      const partial = invoice.paidAmount < invoice.dueAmount;
      const what = invoice.month ? `${formatBsPeriod(invoice.month)} rent` : "One-off";

      return {
        amount: invoice.paidAmount,
        // Only the paid date: an undated payment is filed as such, never under the day it was billed.
        at: invoice.paidDate ?? null,
        badges: partial ? ["Part payment"] : undefined,
        facts: [
          ["Paid", currency(invoice.paidAmount)],
          ["Billed", currency(invoice.dueAmount)],
          ...(partial ? ([["Still owed", currency(invoice.dueAmount - invoice.paidAmount)]] as [string, string][]) : []),
          ["Paid on", invoice.paidDate ? formatHostelDate(invoice.paidDate) : "Not recorded"],
          ["Method", humanize(method)],
          ["For", what],
          ...(invoice.dueDate ? ([["Was due", formatHostelDate(invoice.dueDate)]] as [string, string][]) : []),
          ...(invoice.referenceCode ? ([["Reference", invoice.referenceCode]] as [string, string][]) : []),
          ["Invoice", invoice.id],
        ],
        id: invoice.id,
        // Counted as "in" for the running total paid; drawn as money out below.
        kind: "in",
        link: { href: "/resident/payments", label: "Invoice" },
        method,
        status: humanize(invoice.status),
        title: what,
      };
    });

  // The running figure is what they have paid so far; the rows read as money going out of their pocket.
  return withBalances(rows).map((row) => ({ ...row, kind: "out" }));
}

export function ResidentStatementPage() {
  const resource = usePortalResource<{ invoices: Invoice[] }>("/api/v1/resident/finance/invoices", {
    errorMessage: "Could not load your statement.",
  });
  const rows = useMemo(() => toRows(resource.data?.invoices ?? []), [resource.data]);

  return (
    <StatementView
      balanceLabel="Total paid"
      error={!resource.data ? resource.message : null}
      exportAction={(visible) => (
        <StatementExportButton
          disabled={visible.length === 0}
          onExport={(format) =>
            void downloadTable(
              format,
              "my-statement",
              [
                { key: "date", label: "Paid on" },
                { key: "title", label: "For" },
                { key: "method", label: "Method" },
                { key: "amount", label: "Paid (NPR)" },
                { key: "balance", label: "Total paid (NPR)" },
              ],
              visible.map((row) => ({
                amount: row.amount,
                balance: row.balance ?? "",
                date: row.at ? formatHostelDate(row.at) : "",
                method: humanize(row.method),
                title: row.title,
              })),
              { title: "My statement" },
            )
          }
        />
      )}
      loading={resource.state === "loading" && !resource.data}
      mixed={false}
      overviewHref="/resident/payments"
      rows={rows}
      subtitle="Money paid"
    />
  );
}
