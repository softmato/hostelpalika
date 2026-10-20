"use client";
import { downloadCsv } from "@/lib/downloads/downloader";

import {
  AlertTriangle,
  Clock3,
  Download,
  ExternalLink,
  FileText,
  ReceiptText,
  WalletCards,
} from "@/components/icons";
import Link from "next/link";
import { memo, useMemo, useState } from "react";

import { currency, EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import {
  DataTable,
  DetailField,
  InitialsAvatar,
  ListPager,
  MetricCard,
  PortalPageHeader,
  RailCard,
  RoleButton,
  SearchField,
  SoftBadge,
  TabBar,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  Th,
  statusToneFromLabel,
} from "@/app/_components/portal-dashboard-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { Message } from "./core-portal-shared";
import { MoneyHero, SplitBar } from "./platform-page-ui";

type PlatformPayment = {
  dueAmount: number;
  dueDate: string | null;
  hostelName: string;
  id: string;
  month: string;
  paidAmount: number;
  status: string;
};

type PlatformPaymentProof = {
  amount: number;
  hostelName: string;
  id: string;
  month: string;
  paymentId: string;
  proofImageAssetId: string;
  residentId: string;
  status: string;
  submittedAt: string | null;
  transactionCode: string;
};

type PlatformPaymentsResponse = {
  overview: {
    outstanding: number;
    pendingProofs: number;
    statusCounts: Record<string, number>;
    totalDue: number;
    totalPaid: number;
  };
  proofs: PlatformPaymentProof[];
  recent: PlatformPayment[];
};

const TABS = [
  { key: "ALL", label: "All" },
  { key: "PAID", label: "Paid" },
  { key: "UNPAID", label: "Unpaid" },
  { key: "PARTIAL", label: "Partial" },
  { key: "OVERDUE", label: "Overdue" },
];

const PAGE_SIZE = 10;

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString();
}

function relativeTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export const PlatformPaymentsPageContent = memo(function PlatformPaymentsPageContent() {
  const payments = usePortalResource<PlatformPaymentsResponse>(
    platformEndpoints.payments,
    { errorMessage: "Could not load payments." },
  );
  const { data, message, state } = payments;
  const [tab, setTab] = useState("ALL");
  const [query, setQuery] = useState("");
  const [hostelFilter, setHostelFilter] = useState("");
  const [monthFilter, setMonthFilter] = useState("");
  const [page, setPage] = useState(1);
  const [selectedPaymentId, setSelectedPaymentId] = useState<string | null>(null);

  const overview = data?.overview;
  const recent = useMemo(() => data?.recent ?? [], [data]);
  const proofs = useMemo(() => data?.proofs ?? [], [data]);

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();

    return recent.filter((payment) => {
      if (tab !== "ALL" && payment.status !== tab) return false;
      if (hostelFilter && payment.hostelName !== hostelFilter) return false;
      if (monthFilter && payment.month !== monthFilter) return false;
      if (!term) return true;
      return `${payment.hostelName} ${payment.month}`.toLowerCase().includes(term);
    });
  }, [hostelFilter, monthFilter, query, recent, tab]);

  const hostelNames = useMemo(() => Array.from(new Set(recent.map((payment) => payment.hostelName))), [recent]);
  const months = useMemo(() => Array.from(new Set(recent.map((payment) => payment.month))), [recent]);
  const switchTab = (next: string) => {
    setTab(next);
    setPage(1);
  };

  const paged = useMemo(
    () => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    [page, rows],
  );

  const tabCount = (key: string) =>
    key === "ALL" ? recent.length : (overview?.statusCounts[key] ?? 0);

  const selectedPayment =
    recent.find((payment) => payment.id === selectedPaymentId) ?? recent[0] ?? null;

  return (
    <div className="mx-auto max-w-[1448px] space-y-4">
      <PortalPageHeader
        actions={
          <>
            <RoleButton
              disabled={rows.length === 0}
              onClick={() => downloadCsv("platform-payments", [
                  { key: "hostelName", label: "Hostel" },
                  { key: "month", label: "Period" },
                  { key: "dueAmount", label: "Due" },
                  { key: "paidAmount", label: "Paid" },
                  { key: "status", label: "Status" },
                  { key: "dueDate", label: "Due date" },
                  { key: "id", label: "Reference" },
                ], rows)}
              tone="team"
              variant="outline"
            >
              <Download className="size-3.5" />
              Export
            </RoleButton>
            <RoleButton asChild tone="team">
              <Link href="/platform/transactions">
                <ReceiptText className="size-3.5" />
                Ledger
              </Link>
            </RoleButton>
          </>
        }
        description="Resident payments across every hostel."
        title="Payments"
      />
      <Message value={message} />

      {state === "loading" ? <LoadingRows /> : null}
      {state === "error" ? <EmptyState label="Payments could not be loaded." /> : null}

      {state === "ready" ? (
        <>
          <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr]">
            <MoneyHero
              label="Collected"
              note={`of ${currency(overview?.totalDue ?? 0)} billed · ${currency(overview?.outstanding ?? 0)} still owed`}
              part={overview?.totalPaid ?? 0}
              total={overview?.totalDue ?? 0}
              value={currency(overview?.totalPaid ?? 0)}
            />
            <SplitBar
              parts={[
                { label: "Paid", tone: "brand", value: overview?.statusCounts.PAID ?? 0 },
                { label: "Partial", tone: "amber", value: overview?.statusCounts.PARTIAL ?? 0 },
                { label: "Unpaid", tone: "muted", value: overview?.statusCounts.UNPAID ?? 0 },
                { label: "Overdue", tone: "rose", value: overview?.statusCounts.OVERDUE ?? 0 },
              ]}
              title="Bills by state"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              active={tab === "PAID"}
              icon={WalletCards}
              label="Collected"
              onClick={() => switchTab("PAID")}
              value={currency(overview?.totalPaid ?? 0)}
            />
            <MetricCard
              active={tab === "UNPAID"}
              icon={FileText}
              label="Still due"
              onClick={() => switchTab("UNPAID")}
              tone={(overview?.outstanding ?? 0) > 0 ? "amber" : "teal"}
              value={currency(overview?.outstanding ?? 0)}
            />
            <MetricCard
              icon={Clock3}
              label="Proofs waiting"
              tone={(overview?.pendingProofs ?? 0) > 0 ? "amber" : "teal"}
              value={overview?.pendingProofs ?? 0}
            />
            <MetricCard
              active={tab === "OVERDUE"}
              icon={AlertTriangle}
              label="Overdue"
              onClick={() => switchTab("OVERDUE")}
              tone={(overview?.statusCounts.OVERDUE ?? 0) > 0 ? "rose" : "teal"}
              value={overview?.statusCounts.OVERDUE ?? 0}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
            <Panel>
              <TabBar
                className="mb-3"
                onChange={switchTab}
                tabs={TABS.map((item) => ({ ...item, count: tabCount(item.key) }))}
                value={tab}
              />

              <div className="mb-3 flex flex-wrap items-center gap-2">
                <SearchField
                  onChange={(next) => {
                    setQuery(next);
                    setPage(1);
                  }}
                  placeholder="Search hostel or month"
                  value={query}
                />
                <FilterButton
                  active={(hostelFilter ? 1 : 0) + (monthFilter ? 1 : 0)}
                  onClear={() => {
                    setHostelFilter("");
                    setMonthFilter("");
                    setPage(1);
                  }}
                >
                  <FilterChoice
                    label="Month"
                    onChange={(next) => {
                      setMonthFilter(next);
                      setPage(1);
                    }}
                    options={[{ label: "All", value: "" }, ...months.map((month) => ({ label: month, value: month }))]}
                    value={monthFilter}
                  />
                  <FilterChoice
                    label="Hostel"
                    onChange={(next) => {
                      setHostelFilter(next);
                      setPage(1);
                    }}
                    options={[{ label: "All", value: "" }, ...hostelNames.map((name) => ({ label: name, value: name }))]}
                    value={hostelFilter}
                  />
                </FilterButton>
              </div>

              {rows.length === 0 ? (
                <EmptyState label="No payments in this view." />
              ) : (
                <>
                  <DataTable className="min-w-[660px]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <Th>Hostel</Th>
                        <Th>Month</Th>
                        <Th>Billed</Th>
                        <Th>Paid</Th>
                        <Th>Status</Th>
                        <Th>Due Date</Th>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {paged.map((payment) => (
                        <TableRow
                          className={
                            payment.id === selectedPaymentId
                              ? "bg-role-team-soft/60"
                              : "cursor-pointer"
                          }
                          key={payment.id}
                          onClick={() => setSelectedPaymentId(payment.id)}
                        >
                          <TableCell>
                            <div className="flex items-center gap-2.5">
                              <InitialsAvatar
                                name={payment.hostelName}
                                size="sm"
                                tone="team"
                              />
                              <p className="truncate text-[13.5px] font-semibold text-foreground">
                                {payment.hostelName}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {payment.month}
                          </TableCell>
                          <TableCell>{currency(payment.dueAmount)}</TableCell>
                          <TableCell className="font-semibold text-foreground">
                            {currency(payment.paidAmount)}
                          </TableCell>
                          <TableCell>
                            <SoftBadge tone={statusToneFromLabel(payment.status)}>
                              {payment.status.replaceAll("_", " ")}
                            </SoftBadge>
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-muted-foreground">
                            {formatDate(payment.dueDate)}
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
                    unit="results"
                  />
                </>
              )}
            </Panel>

            <div className="space-y-4">
              <RailCard
                action={
                  <span className="text-[11.5px] font-semibold text-muted-foreground">
                    {overview?.pendingProofs ?? 0} pending
                  </span>
                }
                title="Payment proofs"
              >
                {proofs.length === 0 ? (
                  <p className="px-1 py-4 text-center text-[12px] text-muted-foreground">
                    No proofs are waiting for approval.
                  </p>
                ) : (
                  proofs.map((proof) => (
                    <div
                      className="flex items-start gap-2.5 rounded-xl border border-border/70 p-2.5"
                      key={proof.id}
                    >
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-role-team-soft text-role-team">
                        <ReceiptText className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13px] font-semibold text-foreground">
                          {proof.hostelName}
                        </p>
                        <p className="text-[11.5px] text-muted-foreground">
                          {proof.month} · {currency(proof.amount)}
                        </p>
                        <p className="text-[11.5px] text-muted-foreground">
                          {proof.transactionCode ? `${proof.transactionCode} · ` : ""}
                          {relativeTime(proof.submittedAt)}
                        </p>
                      </div>
                      <a
                        className="shrink-0 rounded p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                        href={`/api/v1/files/${proof.proofImageAssetId}/url`}
                        rel="noreferrer noopener"
                        target="_blank"
                        title="Open proof"
                      >
                        <ExternalLink className="size-3.5" />
                      </a>
                    </div>
                  ))
                )}
                <p className="px-1 pt-1 text-[11.5px] text-muted-foreground">The hostel approves these; read only here.</p>
              </RailCard>

              <RailCard title="Receipt">
                {selectedPayment ? (
                  <div className="space-y-1.5 rounded-xl border border-border/70 p-2.5">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <p className="truncate text-[13px] font-bold text-foreground">
                        {selectedPayment.hostelName}
                      </p>
                      <SoftBadge tone={statusToneFromLabel(selectedPayment.status)}>
                        {selectedPayment.status.replaceAll("_", " ")}
                      </SoftBadge>
                    </div>
                    <DetailField
                      label="Receipt no."
                      value={selectedPayment.id.slice(-8).toUpperCase()}
                    />
                    <DetailField label="For month" value={selectedPayment.month} />
                    <DetailField
                      label="Billed"
                      value={currency(selectedPayment.dueAmount)}
                    />
                    <DetailField
                      label="Paid"
                      value={currency(selectedPayment.paidAmount)}
                    />
                    <DetailField
                      label="Balance"
                      value={currency(
                        Math.max(
                          selectedPayment.dueAmount - selectedPayment.paidAmount,
                          0,
                        ),
                      )}
                    />
                    <DetailField
                      label="Due date"
                      value={formatDate(selectedPayment.dueDate)}
                    />
                  </div>
                ) : (
                  <p className="px-1 py-4 text-center text-[12px] text-muted-foreground">Pick a row to see its receipt.</p>
                )}
              </RailCard>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
});
