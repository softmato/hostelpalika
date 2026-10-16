"use client";
import { downloadCsv } from "@/lib/downloads/downloader";

import {
  ArrowDownUp,
  BadgeDollarSign,
  Download,
  Hash,
  TrendingUp,
  Wallet,
} from "@/components/icons";
import { memo, useMemo, useState } from "react";

import { currency, EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import {
  DataTable,
  FilterBar,
  FilterSelect,
  InitialsAvatar,
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
import { platformEndpoints } from "@/lib/platform-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { Message } from "./core-portal-shared";

type PlatformPayment = {
  dueAmount: number;
  dueDate: string | null;
  hostelName: string;
  id: string;
  month: string;
  paidAmount: number;
  status: string;
};

type PlatformPaymentsResponse = {
  overview: {
    outstanding: number;
    pendingProofs: number;
    statusCounts: Record<string, number>;
    totalDue: number;
    totalPaid: number;
  };
  recent: PlatformPayment[];
};

const TABS = [
  { key: "ALL", label: "All" },
  { key: "SETTLED", label: "Settled" },
  { key: "PARTIAL", label: "Partial" },
  { key: "OUTSTANDING", label: "Outstanding" },
];

const PAGE_SIZE = 12;

/**
 * A payment record becomes a ledger line: fully paid is settled, partially paid
 * is partial, anything else is still owed.
 */
function settlementOf(payment: PlatformPayment) {
  if (payment.paidAmount >= payment.dueAmount && payment.dueAmount > 0) {
    return "SETTLED";
  }
  if (payment.paidAmount > 0) {
    return "PARTIAL";
  }
  return "OUTSTANDING";
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

export const PlatformTransactionsPageContent = memo(
  function PlatformTransactionsPageContent() {
    const transactions = usePortalResource<PlatformPaymentsResponse>(
      platformEndpoints.payments,
      { errorMessage: "Could not load transactions." },
    );
    const { data, message, state } = transactions;
    const [tab, setTab] = useState("ALL");
    const [query, setQuery] = useState("");
    const [hostelFilter, setHostelFilter] = useState("");
    const [page, setPage] = useState(1);

    const ledger = useMemo(
      () =>
        (data?.recent ?? []).map((payment) => ({
          ...payment,
          settlement: settlementOf(payment),
        })),
      [data],
    );

    const rows = useMemo(() => {
      const term = query.trim().toLowerCase();

      return ledger.filter((entry) => {
        if (tab !== "ALL" && entry.settlement !== tab) return false;
        if (hostelFilter && entry.hostelName !== hostelFilter) return false;
        if (!term) return true;
        return `${entry.hostelName} ${entry.month} ${entry.id}`
          .toLowerCase()
          .includes(term);
      });
    }, [hostelFilter, ledger, query, tab]);

    const paged = useMemo(
      () => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      [page, rows],
    );

    const totals = useMemo(
      () => ({
        settled: ledger.filter((entry) => entry.settlement === "SETTLED").length,
        volume: ledger.reduce((sum, entry) => sum + entry.paidAmount, 0),
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
              onClick={() => downloadCsv("platform-transactions", [
                  { key: "hostelName", label: "Hostel" },
                  { key: "month", label: "Period" },
                  { key: "dueAmount", label: "Due" },
                  { key: "paidAmount", label: "Paid" },
                  { key: "status", label: "Status" },
                  { key: "dueDate", label: "Due date" },
                  { key: "id", label: "Reference" },
                ], rows)}
              tone="platform"
              variant="outline"
            >
              <Download className="size-3.5" />
              Export CSV
            </RoleButton>
          }
          breadcrumb={["Home", "Fees & Payments", "Transactions"]}
          description="Every money movement recorded across the platform, with its reference, settlement state, and hostel."
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
              <MetricCard
                icon={ArrowDownUp}
                label="Ledger Entries"
                note="Most recent first"
                tone="teal"
                value={ledger.length}
              />
              <MetricCard
                icon={Wallet}
                label="Settled Volume"
                note="Money actually received"
                noteTone="green"
                tone="green"
                value={currency(totals.volume)}
              />
              <MetricCard
                icon={BadgeDollarSign}
                label="Fully Settled"
                note="Nothing outstanding"
                noteTone="green"
                tone="cyan"
                value={totals.settled}
              />
              <MetricCard
                icon={TrendingUp}
                label="Outstanding"
                note="Still owed"
                noteTone="amber"
                tone="amber"
                value={currency(data?.overview.outstanding ?? 0)}
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
                value={tab}
              />

              <FilterBar>
                <SearchField
                  onChange={(next) => {
                    setQuery(next);
                    setPage(1);
                  }}
                  placeholder="Search by hostel, month, or reference..."
                  value={query}
                />
                <div className="flex flex-wrap gap-2">
                  <FilterSelect
                    defaultLabel="All Hostels"
                    onChange={(next) => {
                      setHostelFilter(next);
                      setPage(1);
                    }}
                    options={Array.from(new Set(ledger.map((entry) => entry.hostelName)))}
                    value={hostelFilter}
                  />
                  <FilterSelect
                    defaultLabel="All Months"
                    options={Array.from(new Set(ledger.map((entry) => entry.month)))}
                  />
                </div>
              </FilterBar>

              {rows.length === 0 ? (
                <EmptyState label="No transactions match these filters." />
              ) : (
                <>
                  <DataTable className="min-w-[820px]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <Th>Reference</Th>
                        <Th>Hostel</Th>
                        <Th>Period</Th>
                        <Th align="right">Billed</Th>
                        <Th align="right">Received</Th>
                        <Th align="right">Balance</Th>
                        <Th>Settlement</Th>
                        <Th>Due Date</Th>
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
                          <TableCell>
                            <div className="flex items-center gap-2.5">
                              <InitialsAvatar
                                name={entry.hostelName}
                                size="sm"
                                tone="platform"
                              />
                              <span className="truncate font-semibold text-foreground">
                                {entry.hostelName}
                              </span>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {entry.month}
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
                            {formatDate(entry.dueDate)}
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
