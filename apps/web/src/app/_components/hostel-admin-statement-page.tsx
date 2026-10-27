"use client";

import { formatBsPeriod, formatHostelDate } from "@hostel/shared/calendar/bs";
import { useMemo } from "react";

import { StatementExportButton, StatementView } from "@/components/statement/statement-view";
import { useWorkspaceHref } from "@/hooks/use-workspace-href";
import { downloadFile, downloadTable } from "@/lib/downloads/downloader";
import { hostelPeriodOf } from "@/lib/hostel-day";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { type StatementRow, withBalances } from "@/lib/statement";

import { currency } from "./shared-ui";

/**
 * The hostel statement on the web — the app's `manage/finance/statement`, laid
 * out the same way (`StatementView`): every rupee that arrived (paid invoices)
 * and every rupee recorded as spent (expenses), newest first, grouped by day,
 * each with the balance after it, counted from the opening balance.
 *
 * Not Transactions (the invoice ledger, what was *raised*) and not Bank and
 * wallet statements (an export matched against it).
 */

type Ledger = {
  entries: {
    createdAt?: string;
    dueAmount: number;
    dueDate?: string;
    id: string;
    method?: string;
    month: string | null;
    paidAmount: number;
    paidDate?: string | null;
    paymentMethod?: string;
    remarks?: string;
    residentId: string;
    residentName: string;
    status: string;
  }[];
  expenses?:
    | {
        amount: number;
        cashStatus: string | null;
        cashTo: { name: string } | null;
        categoryLabel: string;
        id: string;
        method?: string;
        payer: "HOSTEL" | "STAFF";
        recordedBy: { name: string };
        spentOn: string;
        status: string;
        what: string;
      }[]
    | null;
  openingBalance?: { amount: number; asOf: string } | null;
};

function humanize(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase().replaceAll("_", " ");
}

function toRows(ledger: Ledger | undefined, residentsHref: string, expensesHref: string): StatementRow[] {
  const rows: StatementRow[] = [];

  for (const entry of ledger?.entries ?? []) {
    const at = entry.paidDate ?? entry.createdAt ?? null;

    if (entry.paidAmount <= 0) continue;

    const method = (entry.paymentMethod ?? entry.method ?? "OTHER").trim() || "OTHER";
    const partial = entry.paidAmount < entry.dueAmount;
    const what = entry.month ? `${formatBsPeriod(entry.month)} rent` : "One-off";

    rows.push({
      amount: entry.paidAmount,
      at,
      badges: partial ? ["Part payment"] : undefined,
      facts: [
        ["Received", currency(entry.paidAmount)],
        ["Billed", currency(entry.dueAmount)],
        ...(partial ? ([["Still owed", currency(entry.dueAmount - entry.paidAmount)]] as [string, string][]) : []),
        ["Received on", at ? formatHostelDate(at) : "Not recorded"],
        ["Method", humanize(method)],
        ["For", what],
        ...(entry.dueDate ? ([["Was due", formatHostelDate(entry.dueDate)]] as [string, string][]) : []),
        ["Resident", entry.residentName || "Not recorded"],
        ...(entry.remarks ? ([["Remarks", entry.remarks]] as [string, string][]) : []),
        ["Invoice", entry.id],
      ],
      id: entry.id,
      kind: "in",
      link: { href: residentsHref, label: "Resident" },
      method,
      status: humanize(entry.status),
      title: `${what} · ${entry.residentName || "Resident"}`,
    });
  }

  for (const expense of ledger?.expenses ?? []) {
    if (expense.status !== "RECORDED" || expense.cashStatus === "DECLINED") continue;

    const at = `${expense.spentOn}T12:00:00+05:45`;
    const method = (expense.method ?? "CASH").trim() || "CASH";

    rows.push({
      amount: expense.amount,
      at,
      badges: expense.cashTo ? ["To staff cash"] : [expense.categoryLabel],
      facts: [
        [expense.cashTo ? "Handed over" : "Spent", currency(expense.amount)],
        ["On", formatHostelDate(at)],
        ...(expense.cashTo ? ([["To", expense.cashTo.name]] as [string, string][]) : ([["Category", expense.categoryLabel]] as [string, string][])),
        ...(expense.what.trim() ? ([["For", expense.what.trim()]] as [string, string][]) : []),
        ["Paid by", expense.payer === "STAFF" ? "Staff cash" : humanize(method)],
        ["Recorded by", expense.recordedBy.name || "Staff"],
      ],
      id: `e:${expense.id}`,
      kind: expense.cashTo ? "move" : "out",
      link: { href: expensesHref, label: "Expenses" },
      method: expense.payer === "STAFF" ? "CASH" : method,
      status: "Spent",
      title: expense.cashTo
        ? `Cash to ${expense.cashTo.name}`
        : `${expense.what || expense.categoryLabel}${expense.payer === "STAFF" ? ` · ${expense.recordedBy.name}` : ""}`,
    });
  }

  if (ledger?.openingBalance) {
    rows.push({
      amount: Math.abs(ledger.openingBalance.amount),
      at: `${ledger.openingBalance.asOf}T00:00:00+05:45`,
      facts: [
        ["Bank balance", currency(ledger.openingBalance.amount)],
        ["On", formatHostelDate(`${ledger.openingBalance.asOf}T00:00:00+05:45`)],
      ],
      id: "opening",
      kind: ledger.openingBalance.amount >= 0 ? "in" : "out",
      method: "BANK",
      title: "Opening balance",
    });
  }

  return withBalances(rows);
}

/**
 * The PDF is the bank-style statement Reports prints (S.N., date, particulars,
 * Dr, Cr, running balance, opening and closing — `modules/reports/statement-pdf`),
 * over the BS months the rows on screen span, the same as the app's Statement.
 */
function downloadStatementPdf(visible: readonly StatementRow[]) {
  const months = visible
    .flatMap((row) => (row.at ? [hostelPeriodOf(new Date(row.at))] : []))
    .sort();
  const thisMonth = hostelPeriodOf(new Date());
  const from = months[0] ?? thisMonth;
  const to = months.at(-1) ?? thisMonth;

  return downloadFile({
    fileName: from === to ? `statement-${from}.pdf` : `statement-${from}-to-${to}.pdf`,
    label: "Statement",
    mimeType: "application/pdf",
    url: `/api/v1/hostel-admin/reports/statement/pdf?from=${from}&to=${to}`,
  });
}

export function HostelAdminStatementPageContent() {
  const workspaceHref = useWorkspaceHref();
  const resource = usePortalResource<Ledger>(hostelAdminEndpoints.transactions, {
    errorMessage: "Could not load the statement.",
  });
  const rows = useMemo(
    () => toRows(resource.data, workspaceHref("/hostel-admin/residents"), workspaceHref("/hostel-admin/expenses")),
    [resource.data, workspaceHref],
  );
  const mixed = rows.some((row) => row.kind !== "in");

  return (
    <StatementView
      balanceLabel={mixed ? "Balance" : "Total received"}
      error={!resource.data ? resource.message : null}
      exportAction={(visible) => (
        <StatementExportButton
          disabled={visible.length === 0}
          onExport={(format) =>
            format === "pdf"
              ? void downloadStatementPdf(visible)
              : void downloadTable(
              format,
              "statement",
              [
                { key: "date", label: "Date" },
                { key: "title", label: "Details" },
                { key: "direction", label: "Direction" },
                { key: "method", label: "Method" },
                { key: "amount", label: "Amount (NPR)" },
                { key: "balance", label: "Balance (NPR)" },
              ],
              visible.map((row) => ({
                amount: row.amount,
                balance: row.balance ?? "",
                date: row.at ? formatHostelDate(row.at) : "",
                direction: row.kind === "in" ? "In" : row.kind === "out" ? "Out" : "To staff cash",
                method: humanize(row.method),
                title: row.title,
              })),
              { title: "Statement" },
            )
          }
        />
      )}
      loading={resource.state === "loading" && !resource.data}
      mixed={mixed}
      overviewHref={workspaceHref("/hostel-admin/payments")}
      rows={rows}
      subtitle={mixed ? "Money in and out" : "Money received"}
    />
  );
}
