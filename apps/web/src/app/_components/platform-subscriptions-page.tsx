"use client";

import {
  Building2,
  Download,
  FileText,
  ReceiptText,
  TrendingUp,
  WalletCards,
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
  statusToneFromLabel,
} from "@/app/_components/portal-dashboard-ui";
import { downloadFile } from "@/lib/downloads/downloader";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import type { FieldCashRow } from "@/modules/billing/cash-filing.service";
import type { PlanPaymentClaim } from "@/modules/billing/subscription-claim.service";
import type {
  PlatformInvoiceRow,
  PlatformPaymentRow,
  PlatformSubscriptionLedger,
} from "@/modules/billing/platform-subscriptions.service";
import { Message } from "./core-portal-shared";
import { formatBsAdDate } from "@hostel/shared/calendar/bs";

import { FieldCashQueue, SubscriptionClaimQueue } from "./platform-subscription-claims";

/**
 * Plan billing, from the platform's side of the table.
 *
 * ## Two tables, not one merged ledger
 *
 * An invoice and a payment are different objects with different lifecycles —
 * one obligation can carry several instalments — and flattening them into a
 * single feed would mean either repeating the invoice on every payment row or
 * losing which payment cleared which demand. So they are two lists under one
 * set of totals, switched by a tab, and the invoice number is the join a reader
 * makes by eye.
 *
 * ## The "issued by" column is the point of this screen right now
 *
 * Softmato is the issuer of record and is down, so we are printing the
 * documents. Every invoice therefore says which side produced the page the
 * hostel is holding, and the metric row counts them. When they come back this
 * column goes quiet on its own — new rows say `Softmato`, old ones keep saying
 * what was true when they were raised — and nothing has to be migrated to make
 * the history honest.
 *
 * ## Downloads go through the global downloader
 *
 * Not an `<a download>`: the document route is authenticated and returns bytes,
 * so the browser needs the session on the request and the file has to be
 * assembled before it is offered. `downloadFile` already does that with a live
 * row in the toaster, which is what every other file in this portal uses.
 */

const TABS = [
  { key: "INVOICES", label: "Invoices" },
  { key: "PAYMENTS", label: "Payments" },
  /*
   * Third and last, but it is the only tab with work in it. The two before it
   * are records; this is a queue with a turnaround promise attached, so it
   * carries a count and the count is what makes it findable — a reviewer opens
   * this screen because the badge said a number, not because they browse.
   */
  { key: "REVIEW", label: "Manual review" },
];

const PAGE_SIZE = 12;

function formatDate(value: string | null) {
  if (!value) return "—";

  // The platform's calendar is Bikram Sambat, here as everywhere.
  return formatBsAdDate(new Date(value)) || "—";
}

/** `SOFTMATO` is a rail, and nobody paid "by Softmato". */
function methodLabel(payment: PlatformPaymentRow) {
  if (payment.method === "CASH") return "Cash";
  /*
   * Named for what the payer did, not for the row's enum. "Manual" alone reads
   * as a data-entry mode; what actually happened is that somebody scanned our
   * QR out of their banking app and sent a screenshot back.
   */
  if (payment.method === "MANUAL") return "QR — manual";

  return payment.provider || "Online";
}

/**
 * `IN_REVIEW` is the one status whose enum is unreadable to a person, and it is
 * the one that most needs reading: it means money a hostel says it sent that
 * nobody has checked yet. Everything else already reads as English lower-cased.
 */
function statusLabel(status: string) {
  return status === "IN_REVIEW" ? "Manual review" : status.replaceAll("_", " ");
}

export const PlatformSubscriptionsPageContent = memo(
  function PlatformSubscriptionsPageContent() {
    const ledger = usePortalResource<PlatformSubscriptionLedger>(
      platformEndpoints.subscriptions,
      { errorMessage: "Could not load plan billing." },
    );
    /*
     * A second read rather than a field on the ledger. The queue changes on a
     * different clock — it empties as people work it — and a reviewer who has
     * just confirmed a payment needs both refreshed: the claim leaves this
     * list, and the payment it became appears in the one next door.
     */
    const claimQueue = usePortalResource<{ claims: PlanPaymentClaim[] }>(
      platformEndpoints.subscriptionClaims,
      { errorMessage: "Could not load the manual review queue." },
    );
    const cashQueue = usePortalResource<{ cash: FieldCashRow[]; confirmUrl: string }>(
      platformEndpoints.subscriptionCash,
      { errorMessage: "Could not load the field cash queue." },
    );
    const { data, message, state } = ledger;

    const [tab, setTab] = useState("INVOICES");
    const [query, setQuery] = useState("");
    const [page, setPage] = useState(1);

    const invoices = useMemo(() => data?.invoices ?? [], [data]);
    const payments = useMemo(() => data?.payments ?? [], [data]);
    const totals = data?.totals;

    const term = query.trim().toLowerCase();

    const invoiceRows = useMemo(
      () =>
        invoices.filter((invoice) =>
          term
            ? `${invoice.hostelName} ${invoice.invoiceNumber} ${invoice.printedNumber} ${invoice.planName}`
                .toLowerCase()
                .includes(term)
            : true,
        ),
      [invoices, term],
    );

    const paymentRows = useMemo(
      () =>
        payments.filter((payment) =>
          term
            ? `${payment.hostelName} ${payment.invoiceNumber} ${payment.receiptNumber ?? ""} ${payment.printedNumber ?? ""}`
                .toLowerCase()
                .includes(term)
            : true,
        ),
      [payments, term],
    );

    const claims = useMemo(
      () => claimQueue.data?.claims ?? [],
      [claimQueue.data],
    );

    const claimRows = useMemo(
      () =>
        claims.filter((claim) =>
          term
            ? `${claim.hostelName} ${claim.invoiceNumber} ${claim.reference ?? ""}`
                .toLowerCase()
                .includes(term)
            : true,
        ),
      [claims, term],
    );

    const rows =
      tab === "INVOICES"
        ? invoiceRows
        : tab === "PAYMENTS"
          ? paymentRows
          : claimRows;
    const paged = useMemo(
      () => rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
      [page, rows],
    );

    const download = (
      kind: "invoice" | "receipt",
      url: string,
      number: string,
    ) =>
      void downloadFile({
        fileName: `${number.replace(/\//g, "-")}.pdf`,
        label: kind === "invoice" ? "Invoice" : "Receipt",
        mimeType: "application/pdf",
        url,
      });

    return (
      <div className="mx-auto max-w-[1448px] space-y-4">
        <PortalPageHeader
          breadcrumb={["Home", "Fees & Payments", "Plan Billing"]}
          description="Every plan invoice raised to a hostel and every payment received against one. Resident rent lives on Payments — this is what hostels pay the platform."
          title="Plan Billing"
        />
        <Message value={message} />

        {state === "loading" ? <LoadingRows /> : null}
        {state === "error" ? (
          <EmptyState label="Plan billing could not be loaded." />
        ) : null}

        {state === "ready" ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard
                icon={WalletCards}
                label="Collected"
                note="Settled payments only"
                noteTone="green"
                tone="green"
                value={currency(totals?.collected ?? 0)}
              />
              <MetricCard
                icon={FileText}
                label="Billed"
                note="Every invoice ever raised"
                noteTone="teal"
                tone="teal"
                value={currency(totals?.billed ?? 0)}
              />
              <MetricCard
                icon={TrendingUp}
                label="Outstanding"
                note="Open and partly paid"
                noteTone="amber"
                tone="amber"
                value={currency(totals?.outstanding ?? 0)}
              />
              <MetricCard
                icon={Building2}
                label="Active Plans"
                note={
                  totals?.issuedByPlatform
                    ? `${totals.issuedByPlatform} invoice${totals.issuedByPlatform === 1 ? "" : "s"} issued by us`
                    : "All documents issued by Softmato"
                }
                noteTone={totals?.issuedByPlatform ? "amber" : "green"}
                tone="green"
                value={totals?.activePlans ?? 0}
              />
            </div>

            <Panel>
              <TabBar
                className="mb-3"
                onChange={(next) => {
                  setTab(next);
                  setPage(1);
                }}
                tabs={TABS.map((item) => ({
                  ...item,
                  count:
                    item.key === "INVOICES"
                      ? invoices.length
                      : item.key === "PAYMENTS"
                        ? payments.length
                        : claims.length + (cashQueue.data?.cash.length ?? 0),
                }))}
                value={tab}
              />

              <FilterBar>
                <SearchField
                  onChange={(next) => {
                    setQuery(next);
                    setPage(1);
                  }}
                  placeholder="Search by hostel, invoice or receipt number..."
                  value={query}
                />
                <FilterSelect
                  defaultLabel="All Hostels"
                  options={Array.from(
                    new Set(invoices.map((invoice) => invoice.hostelName)),
                  )}
                />
              </FilterBar>

              {tab === "REVIEW" ? (
                <div className="space-y-5">
                  <section className="space-y-2">
                    <h3 className="text-[12.5px] font-bold text-foreground">Cash from field agents</h3>
                    <FieldCashQueue
                      confirmUrl={cashQueue.data?.confirmUrl ?? "https://admin.softmato.com/cash"}
                      onChecked={() => {
                        cashQueue.refresh();
                        ledger.refresh();
                      }}
                      rows={cashQueue.data?.cash ?? []}
                    />
                  </section>
                  <section className="space-y-2">
                    <h3 className="text-[12.5px] font-bold text-foreground">QR payments with proof</h3>
                <SubscriptionClaimQueue
                  claims={claimRows}
                  onReviewed={() => {
                    /*
                     * Both, and in this order for no reason other than that
                     * they are independent: a confirmed claim leaves the queue
                     * and reappears as a settled payment in the tab next door,
                     * and a reviewer who switches straight to it must not read
                     * a stale ledger.
                     */
                    claimQueue.refresh();
                    ledger.refresh();
                  }}
                />
                  </section>
                </div>
              ) : rows.length === 0 ? (
                <EmptyState
                  label={
                    tab === "INVOICES"
                      ? "No plan invoices yet."
                      : "No plan payments yet."
                  }
                />
              ) : (
                <>
                  {tab === "INVOICES" ? (
                    <DataTable className="min-w-[900px]">
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <Th>Hostel</Th>
                          <Th>Invoice</Th>
                          <Th>Plan</Th>
                          <Th>Amount</Th>
                          <Th>Received</Th>
                          <Th>Status</Th>
                          <Th>Issued</Th>
                          <Th>Document</Th>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(paged as PlatformInvoiceRow[]).map((invoice) => (
                          <TableRow key={invoice.invoiceNumber}>
                            <TableCell>
                              <div className="flex items-center gap-2.5">
                                <InitialsAvatar
                                  name={invoice.hostelName}
                                  size="sm"
                                  tone="platform"
                                />
                                <p className="truncate font-semibold text-foreground">
                                  {invoice.hostelName}
                                </p>
                              </div>
                            </TableCell>
                            <TableCell>
                              {/*
                                The printed number leads because it is what a
                                hostel reads off the page they are holding; ours
                                sits under it because it is what support and
                                every other screen in this portal index by.
                              */}
                              <p className="font-mono text-[11.5px] font-semibold text-foreground">
                                {invoice.printedNumber}
                              </p>
                              <p className="font-mono text-[10.5px] text-muted-foreground">
                                {invoice.invoiceNumber}
                                {invoice.issuedBy === "platform"
                                  ? " · issued by us"
                                  : ""}
                              </p>
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {invoice.planName}
                            </TableCell>
                            <TableCell>{currency(invoice.amount)}</TableCell>
                            <TableCell className="font-semibold text-foreground">
                              {currency(invoice.paid)}
                            </TableCell>
                            <TableCell>
                              <SoftBadge
                                tone={statusToneFromLabel(invoice.status)}
                              >
                                {invoice.status}
                              </SoftBadge>
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-muted-foreground">
                              {formatDate(invoice.issuedAt)}
                            </TableCell>
                            <TableCell>
                              <RoleButton
                                onClick={() =>
                                  download(
                                    "invoice",
                                    invoice.documentUrl,
                                    invoice.printedNumber,
                                  )
                                }
                                tone="platform"
                                variant="outline"
                              >
                                <Download className="size-3.5" />
                                PDF
                              </RoleButton>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </DataTable>
                  ) : (
                    <DataTable className="min-w-[900px]">
                      <TableHeader>
                        <TableRow className="hover:bg-transparent">
                          <Th>Hostel</Th>
                          <Th>Receipt</Th>
                          <Th>Against</Th>
                          <Th>Amount</Th>
                          <Th>Method</Th>
                          <Th>Status</Th>
                          <Th>Paid</Th>
                          <Th>Document</Th>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {(paged as PlatformPaymentRow[]).map((payment, index) => (
                          <TableRow
                            key={`${payment.receiptNumber ?? payment.printedNumber ?? "row"}-${index}`}
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
                            <TableCell>
                              <p className="font-mono text-[11.5px] font-semibold text-foreground">
                                {payment.printedNumber ??
                                  payment.receiptNumber ??
                                  "—"}
                              </p>
                              {payment.receiptNumber &&
                              payment.printedNumber ? (
                                <p className="font-mono text-[10.5px] text-muted-foreground">
                                  {payment.receiptNumber}
                                </p>
                              ) : null}
                            </TableCell>
                            <TableCell className="font-mono text-[11px] text-muted-foreground">
                              {payment.invoiceNumber}
                            </TableCell>
                            <TableCell className="font-semibold text-foreground">
                              {currency(payment.amount)}
                            </TableCell>
                            <TableCell className="text-muted-foreground">
                              {methodLabel(payment)}
                            </TableCell>
                            <TableCell>
                              <SoftBadge
                                tone={statusToneFromLabel(payment.status)}
                              >
                                {statusLabel(payment.status)}
                              </SoftBadge>
                            </TableCell>
                            <TableCell className="whitespace-nowrap text-muted-foreground">
                              {formatDate(payment.paidAt)}
                            </TableCell>
                            <TableCell>
                              {payment.documentUrl ? (
                                <RoleButton
                                  onClick={() =>
                                    download(
                                      "receipt",
                                      payment.documentUrl as string,
                                      payment.printedNumber ??
                                        payment.receiptNumber ??
                                        "receipt",
                                    )
                                  }
                                  tone="platform"
                                  variant="outline"
                                >
                                  <ReceiptText className="size-3.5" />
                                  PDF
                                </RoleButton>
                              ) : (
                                <span className="text-[11px] text-muted-foreground">
                                  {/* No receipt before the money. */}
                                  —
                                </span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </DataTable>
                  )}

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
          </>
        ) : null}
      </div>
    );
  },
);
