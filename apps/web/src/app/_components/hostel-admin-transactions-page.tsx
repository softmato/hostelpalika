"use client";
import { downloadCsv } from "@/lib/downloads/downloader";

import { ArrowDownUp, BadgeDollarSign, Download, Hash, Wallet } from "@/components/icons";
import { memo, useMemo, useState } from "react";

import { currency, EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import {
  DataTable,
  FilterBar,
  FilterSelect,
  ListPager,
  MetricCard,
  PortalPageHeader,
  RoleButton,
  SearchField,
  SoftBadge,
  TabBar,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  Th,
} from "@/app/_components/portal-dashboard-ui";
import { monthLabel } from "@/lib/format-month";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { Message } from "./core-portal-shared";

/**
 * One invoice, as `GET /finance/invoices/ledger` returns it.
 *
 * `month` is nullable because it genuinely is: an admission fee belongs to no
 * period (see `Invoice.period`), and those are exactly the rows the month matrix
 * cannot show — which is half the reason this screen exists.
 */
type Payment = {
  createdAt?: string;
  dueAmount: number;
  dueDate?: string;
  id: string;
  month: string | null;
  paidAmount: number;
  paidDate?: string;
  paymentMethod?: string;
  remarks?: string;
  residentId: string;
  residentName: string;
  status: string;
};

/** What the Period column says for an invoice that belongs to no month. */
const ONE_OFF = "One-off";

const TABS = [
  { key: "ALL", label: "All" },
  { key: "SETTLED", label: "Settled" },
  { key: "PARTIAL", label: "Partial" },
  { key: "OUTSTANDING", label: "Outstanding" },
];

const PAGE_SIZE = 12;

function settlementOf(payment: Payment) {
  if (payment.paidAmount >= payment.dueAmount && payment.dueAmount > 0) return "SETTLED";
  if (payment.paidAmount > 0) return "PARTIAL";
  return "OUTSTANDING";
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

export const HostelAdminTransactionsPageContent = memo(
  function HostelAdminTransactionsPageContent() {
    const [query, setQuery] = useState("");
    const [tab, setTab] = useState("ALL");
    const [methodFilter, setMethodFilter] = useState("");
    const [monthFilter, setMonthFilter] = useState("");
    const [page, setPage] = useState(1);

    const paymentsResource = usePortalResource<{
      entries: Payment[];
      openingBalance?: { amount: number; asOf: string } | null;
      truncated: boolean;
    }>(hostelAdminEndpoints.transactions, {
      errorMessage: "Could not load transactions.",
    });

    const payments = useMemo(
      () => paymentsResource.data?.entries ?? [],
      [paymentsResource.data],
    );
    const message = paymentsResource.message;
    const state = paymentsResource.state;

    const ledger = useMemo(
      () =>
        payments.map((payment) => ({
          ...payment,
          period: payment.month ?? ONE_OFF,
          settlement: settlementOf(payment),
        })),
      [payments],
    );

    const rows = useMemo(() => {
      const term = query.trim().toLowerCase();

      return ledger.filter((entry) => {
        if (tab !== "ALL" && entry.settlement !== tab) return false;
        if (methodFilter && entry.paymentMethod !== methodFilter) return false;
        if (monthFilter && entry.period !== monthFilter) return false;
        if (!term) return true;
        // Both spellings of the month are searchable. The owner reading this
        // table thinks in `Bhadra`, and the reference they were sent by email
        // may say `2083-05`; matching only the key means typing the month name
        // returns nothing on a screen that is visibly full of that month.
        return `${monthLabel(entry.period)} ${entry.period} ${entry.id} ${entry.residentName} ${entry.remarks ?? ""}`
          .toLowerCase()
          .includes(term);
      });
    }, [ledger, methodFilter, monthFilter, query, tab]);

    const paged = useMemo(
      () => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      [page, rows],
    );

    const totals = useMemo(
      () => ({
        collected: ledger.reduce((sum, entry) => sum + entry.paidAmount, 0),
        outstanding: ledger.reduce(
          (sum, entry) => sum + Math.max(entry.dueAmount - entry.paidAmount, 0),
          0,
        ),
        settled: ledger.filter((entry) => entry.settlement === "SETTLED").length,
      }),
      [ledger],
    );

    const tabCount = (key: string) =>
      key === "ALL"
        ? ledger.length
        : ledger.filter((entry) => entry.settlement === key).length;

    return (
      <div className="mx-auto max-w-[1448px] space-y-4">
        <PortalPageHeader
          actions={
            <RoleButton
              disabled={rows.length === 0}
              onClick={() =>
                downloadCsv(
                  "transactions",
                  [
                    { key: "id", label: "Reference" },
                    { key: "residentName", label: "Resident" },
                    { key: "period", label: "Period" },
                    { key: "dueAmount", label: "Due" },
                    { key: "paidAmount", label: "Paid" },
                    { key: "settlement", label: "Settlement" },
                    { key: "paymentMethod", label: "Method" },
                    { key: "paidDate", label: "Paid on" },
                    { key: "remarks", label: "Remarks" },
                  ],
                  rows,
                )
              }
              tone="admin"
              variant="outline"
            >
              <Download className="size-3.5" />
              Export CSV
            </RoleButton>
          }
          breadcrumb={["Home", "Fees & Payments", "Transactions"]}
          description="Complete payment ledger for this hostel with method, reference, and settlement state."
          title="Transactions"
        />
        <Message value={message} />

        {state === "loading" ? <LoadingRows /> : null}
        {state === "error" ? (
          <EmptyState label="Transactions could not be loaded." />
        ) : null}

        {state === "ready" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {paymentsResource.data?.openingBalance ? (
                // The bank's figure the hostel started from (docs/FIELD_FIXES_2026_10.md §4).
                <MetricCard
                  icon={ArrowDownUp}
                  label="Opening balance"
                  note={`Bank, ${formatDate(paymentsResource.data.openingBalance.asOf)}`}
                  tone="cyan"
                  value={currency(paymentsResource.data.openingBalance.amount)}
                />
              ) : (
                <MetricCard
                  icon={ArrowDownUp}
                  label="Ledger Entries"
                  note="Most recent first"
                  tone="cyan"
                  value={ledger.length}
                />
              )}
              <MetricCard
                icon={Wallet}
                label="Collected"
                note="Received to date"
                noteTone="green"
                tone="green"
                value={currency(totals.collected)}
              />
              <MetricCard
                icon={BadgeDollarSign}
                label="Fully Settled"
                note="Nothing outstanding"
                noteTone="green"
                tone="teal"
                value={totals.settled}
              />
              <MetricCard
                icon={Hash}
                label="Outstanding"
                note="Still owed"
                noteTone="amber"
                tone="amber"
                value={currency(totals.outstanding)}
              />
            </div>

            <Panel>
              <TabBar
                className="mb-3"
                onChange={(next) => {
                  setTab(next);
                  setPage(1);
                }}
                tabs={TABS.map((item) => ({ ...item, count: tabCount(item.key) }))}
                tone="admin"
                value={tab}
              />

              <FilterBar>
                <SearchField
                  onChange={(next) => {
                    setQuery(next);
                    setPage(1);
                  }}
                  placeholder="Search by resident, month, or reference..."
                  value={query}
                />
                <div className="flex flex-wrap gap-2">
                  <FilterSelect
                    defaultLabel="All Methods"
                    onChange={(next) => {
                      setMethodFilter(next);
                      setPage(1);
                    }}
                    options={
                      Array.from(
                        new Set(
                          ledger.map((entry) => entry.paymentMethod).filter(Boolean),
                        ),
                      ) as string[]
                    }
                    value={methodFilter}
                  />
                  <FilterSelect
                    defaultLabel="All Months"
                    onChange={(next) => {
                      setMonthFilter(next);
                      setPage(1);
                    }}
                    options={Array.from(
                      new Set(ledger.map((entry) => entry.period)),
                    ).map((period) => ({ label: monthLabel(period), value: period }))}
                    value={monthFilter}
                  />
                </div>
              </FilterBar>

              {rows.length === 0 ? (
                <EmptyState label="No transactions match these filters." />
              ) : (
                <>
                  <DataTable className="min-w-[960px]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <Th>Reference</Th>
                        <Th>Resident</Th>
                        <Th>Period</Th>
                        <Th>Method</Th>
                        <Th align="right">Billed</Th>
                        <Th align="right">Received</Th>
                        <Th align="right">Balance</Th>
                        <Th>Settlement</Th>
                        <Th>Paid On</Th>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paged.map((entry) => (
                        <TableRow key={entry.id}>
                          <TableCell>
                            <span className="inline-flex items-center gap-1 font-mono text-[11.5px] font-semibold text-foreground">
                              <Hash className="size-3 text-muted-foreground" />
                              {entry.id.slice(-10).toUpperCase()}
                            </span>
                          </TableCell>
                          <TableCell className="font-medium text-foreground">
                            {entry.residentName || "—"}
                          </TableCell>
                          {/* `Bhadra 2083 BS`, not `2083-05`. The key is what
                              the row is stored under; it is not a thing to put
                              in front of somebody reconciling a ledger. */}
                          <TableCell className="text-muted-foreground">
                            {monthLabel(entry.period)}
                          </TableCell>
                          <TableCell>
                            <SoftBadge tone="slate">
                              {entry.paymentMethod || "—"}
                            </SoftBadge>
                          </TableCell>
                          <TableCell className="text-right">
                            {currency(entry.dueAmount)}
                          </TableCell>
                          <TableCell className="text-right font-semibold text-foreground">
                            {currency(entry.paidAmount)}
                          </TableCell>
                          <TableCell className="text-right text-muted-foreground">
                            {currency(Math.max(entry.dueAmount - entry.paidAmount, 0))}
                          </TableCell>
                          <TableCell>
                            <SoftBadge
                              tone={
                                entry.settlement === "SETTLED"
                                  ? "green"
                                  : entry.settlement === "PARTIAL"
                                    ? "amber"
                                    : "rose"
                              }
                            >
                              {entry.settlement}
                            </SoftBadge>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {formatDate(entry.paidDate)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </DataTable>
                  <ListPager
                    onPageChange={setPage}
                    page={page}
                    pageSize={PAGE_SIZE}
                    showPageSize
                    tone="admin"
                    total={rows.length}
                    unit="transactions"
                  />
                </>
              )}
            </Panel>
          </>
        ) : null}
      </div>
    );
  },
);
