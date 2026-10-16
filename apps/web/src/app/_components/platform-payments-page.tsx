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
  FilterBar,
  FilterSelect,
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
  const [page, setPage] = useState(1);
  const [selectedPaymentId, setSelectedPaymentId] = useState<string | null>(null);

  const overview = data?.overview;
  const recent = useMemo(() => data?.recent ?? [], [data]);
  const proofs = useMemo(() => data?.proofs ?? [], [data]);

  const rows = useMemo(() => {
    const term = query.trim().toLowerCase();

    return recent.filter((payment) => {
      if (tab !== "ALL" && payment.status !== tab) return false;
      if (!term) return true;
      return `${payment.hostelName} ${payment.month}`.toLowerCase().includes(term);
    });
  }, [query, recent, tab]);

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
              tone="platform"
              variant="outline"
            >
              <Download className="size-3.5" />
              Export
            </RoleButton>
            <RoleButton asChild tone="platform">
              <Link href="/platform/transactions">
                <ReceiptText className="size-3.5" />
                View Ledger
              </Link>
            </RoleButton>
          </>
        }
        breadcrumb={["Home", "Fees & Payments", "Payments"]}
        description="Platform-wide roll-up of resident payments recorded across every hostel."
        title="Payments"
      />
      <Message value={message} />

      {state === "loading" ? <LoadingRows /> : null}
      {state === "error" ? <EmptyState label="Payments could not be loaded." /> : null}

      {state === "ready" ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              icon={WalletCards}
              label="Total Collection"
              note="Across all hostels"
              noteTone="green"
              tone="green"
              value={currency(overview?.totalPaid ?? 0)}
            />
            <MetricCard
              icon={FileText}
              label="Due Amount"
              note="Outstanding balance"
              noteTone="amber"
              tone="teal"
              value={currency(overview?.outstanding ?? 0)}
            />
            <MetricCard
              icon={Clock3}
              label="Pending Proofs"
              note="Awaiting approval"
              noteTone="amber"
              tone="amber"
              value={overview?.pendingProofs ?? 0}
            />
            <MetricCard
              icon={AlertTriangle}
              label="Overdue"
              note="Needs follow-up"
              noteTone="rose"
              tone="rose"
              value={overview?.statusCounts.OVERDUE ?? 0}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-[1.7fr_1fr]">
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
                  placeholder="Search by hostel or month..."
                  value={query}
                />
                <div className="flex flex-wrap gap-2">
                  <FilterSelect
                    defaultLabel="All Hostels"
                    options={Array.from(
                      new Set(recent.map((payment) => payment.hostelName)),
                    )}
                  />
                  <FilterSelect
                    defaultLabel="All Methods"
                    options={["eSewa", "Khalti", "Fonepay", "Bank Transfer", "Cash"]}
                  />
                  <FilterSelect
                    defaultLabel="All Months"
                    options={Array.from(new Set(recent.map((payment) => payment.month)))}
                  />
                </div>
              </FilterBar>

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
                              ? "bg-role-platform-soft/40"
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
                                tone="platform"
                              />
                              <p className="truncate font-semibold text-foreground">
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
                  <span className="text-[11px] font-semibold text-muted-foreground">
                    {overview?.pendingProofs ?? 0} pending
                  </span>
                }
                title={`Payment Proofs (${proofs.length})`}
              >
                {proofs.length === 0 ? (
                  <p className="px-1 py-4 text-center text-[12px] text-muted-foreground">
                    No proofs are waiting for approval.
                  </p>
                ) : (
                  proofs.map((proof) => (
                    <div
                      className="flex items-start gap-2.5 rounded-lg border border-border/70 bg-muted/15 p-2"
                      key={proof.id}
                    >
                      <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-role-platform-soft text-role-platform">
                        <ReceiptText className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[12px] font-semibold text-foreground">
                          {proof.hostelName}
                        </p>
                        <p className="text-[10.5px] text-muted-foreground">
                          {proof.month} · {currency(proof.amount)}
                        </p>
                        <p className="text-[10.5px] text-muted-foreground">
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
                <p className="px-1 pt-1 text-[10.5px] leading-4 text-muted-foreground">
                  Proofs are approved by the hostel admin who owns the record — the
                  platform view is read-only.
                </p>
              </RailCard>

              <RailCard title="Receipt Preview">
                {selectedPayment ? (
                  <div className="space-y-1.5 rounded-lg border border-border/70 bg-muted/15 p-2.5">
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <p className="truncate text-[12.5px] font-bold text-foreground">
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
                    <p className="border-t border-border/50 pt-1.5 text-[10px] text-muted-foreground">
                      Generated from the payment record. Select a row to preview it.
                    </p>
                  </div>
                ) : (
                  <p className="px-1 py-4 text-center text-[12px] text-muted-foreground">
                    Select a payment row to preview its receipt.
                  </p>
                )}
              </RailCard>

              <RailCard title="Collection Summary">
                {[
                  { label: "Total collected", value: currency(overview?.totalPaid ?? 0) },
                  { label: "Outstanding", value: currency(overview?.outstanding ?? 0) },
                  { label: "Total billed", value: currency(overview?.totalDue ?? 0) },
                ].map((item) => (
                  <div
                    className="flex items-center justify-between border-b border-border/50 pb-1.5 last:border-0 last:pb-0"
                    key={item.label}
                  >
                    <span className="text-[12px] text-muted-foreground">
                      {item.label}
                    </span>
                    <span className="text-[12.5px] font-semibold text-foreground">
                      {item.value}
                    </span>
                  </div>
                ))}
              </RailCard>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
});
