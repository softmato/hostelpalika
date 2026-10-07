"use client";

import {
  CalendarDays,
  Check,
  CircleAlert,
  Download,
  Loader2,
  ReceiptText,
  Upload,
  WalletCards,
} from "lucide-react";
import { memo, useCallback, useMemo, useState } from "react";

import { currency, EmptyState, LoadingRows } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ResidentClaimForm } from "@/app/_components/resident-claim-form";
import { ShareReceiptSteps } from "@/app/_components/share-receipt-steps";
import { ResidentPayInvoicePanel } from "@/app/_components/resident-pay-invoice-panel";
import {
  dayMonthYear,
  dayMonthYearBoth,
  dayMonthYearBs,
  daysLeftLabel,
  monthLabel,
} from "@/lib/format-month";
import { formatBsDayMonth } from "@/lib/hostel-day";
import { bsPeriodOf } from "@hostel/shared/calendar/bs";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { downloadFile } from "@/lib/downloads/downloader";
import { residentEndpoints } from "@/lib/resident-endpoints";
import { cn } from "@/lib/utils";
import { OfferProgramBanner } from "./resident-offer-program";
import { type Payment, type PaymentProof, Message } from "./resident-shared";
import {
  DataTable,
  EmptyInline,
  MetricCard,
  PortalPageHeader,
  RoleButton,
  SectionCard,
  SoftBadge,
  statusToneFromLabel,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./portal-dashboard-ui";

/**
 * The resident's fee and payment screen (target §11.1, §11.2).
 *
 * Rebuilt around a single question — *what do I owe right now, and how do I pay
 * it* — because that is the only reason this page gets opened. Everything else
 * is history, and history belongs below the fold.
 *
 * Three things drive the layout:
 *
 * - **One invoice is the subject.** The next open month gets a full-width focus
 *   card with the amount, the month spelled out and the days remaining. The
 *   table underneath is a record, not a to-do list; when a table is the primary
 *   surface, "which of these six rows is the one I act on" becomes the
 *   resident's problem instead of ours.
 * - **The claim form is a step, not a sidebar.** It only appears once they say
 *   they have paid, and it lives in `resident-claim-form.tsx` — it grew a
 *   reference-code check, a per-method guide to finding a transaction id and the
 *   two instant rejections (§11.3), none of which is about this list of months.
 * - **Months are written out.** "2026-07" was on every row of a rent statement.
 */

/**
 * What an open invoice sorts by, when the point is "which have I owed longest".
 *
 * Not `month`, because not every invoice has one. A one-off belongs to no
 * period — the joining bill is the one every hostel raises, and it arrives
 * before the resident's first month of rent exists — so its `month` is null,
 * and calling `localeCompare` on it threw before the page rendered a row.
 *
 * A one-off is placed by its due date instead, converted to the same Bikram
 * Sambat period key so the two kinds compare as one sequence rather than by
 * two different rulers. An invoice with neither sorts first: nothing else is
 * known about it, and an unplaceable open bill is better in front of the
 * resident than buried under six months of rent.
 */
function openOrder(payment: Payment): string {
  if (payment.month) {
    return payment.month;
  }

  const due = payment.dueDate ? new Date(payment.dueDate) : null;

  return due && !Number.isNaN(due.getTime()) ? bsPeriodOf(due) : "";
}

/**
 * The one invoice the resident is here about.
 *
 * Shows nothing when everything is settled — an empty focus card that says
 * "NPR 0" reads as a bill for zero rupees, which is a support question.
 */
function FocusCard({
  credit,
  onPay,
  onSubmitProof,
  payment,
  pendingClaim,
  rejectedClaim,
}: {
  credit: number;
  onPay: () => void;
  onSubmitProof: () => void;
  payment: Payment;
  pendingClaim: PaymentProof | undefined;
  /**
   * The hostel's last rejection for this month, and only when nothing is
   * pending — a resident who has already re-submitted is waiting again, so
   * leading with the old rejection would tell them to act twice.
   */
  rejectedClaim: PaymentProof | undefined;
}) {
  const outstanding = Math.max(payment.dueAmount - payment.paidAmount, 0);
  const overdue = payment.status === "OVERDUE";
  const partlyPaid = payment.paidAmount > 0 && outstanding > 0;

  return (
    <section
      className={cn(
        "rounded-2xl border-2 p-5 shadow-sm sm:p-6",
        overdue
          ? "border-rose-500/40 bg-rose-500/5"
          : "border-role-resident/40 bg-role-resident/5",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold text-muted-foreground">
            {monthLabel(payment.month)}
          </p>
          {/* **The big number is labelled.** It is the *remaining* balance, not
              the month's rent, and on a part-paid month the two differ — a
              resident who paid NPR 60 of NPR 1,290 was shown a bare "NPR 1,230"
              under the month's name and had no way to tell which of the two
              numbers it was, or whether their 60 had registered at all. */}
          <p className="mt-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {partlyPaid ? "Still to pay" : "Amount due"}
          </p>
          <p className="font-heading text-3xl font-bold text-foreground sm:text-4xl">
            {currency(outstanding)}
          </p>
          {/* The arithmetic, written out. Every part-paid month raises the same
              support question — *where did my payment go* — and the answer is a
              subtraction the resident can check against their own bank app. */}
          {partlyPaid ? (
            <p className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[13px] text-muted-foreground">
              <span>{currency(payment.dueAmount)} billed</span>
              <span aria-hidden>−</span>
              <span className="font-semibold text-emerald-700 dark:text-emerald-400">
                {currency(payment.paidAmount)} received
              </span>
              <span aria-hidden>=</span>
              <span className="font-semibold text-foreground">
                {currency(outstanding)}
              </span>
            </p>
          ) : null}
          <p className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <CalendarDays className="size-3.5" />
              Due {dayMonthYearBoth(payment.dueDate)}
            </span>
            <span
              className={cn(
                "font-semibold",
                overdue ? "text-rose-700 dark:text-rose-400" : "text-foreground",
              )}
            >
              · {daysLeftLabel(payment.dueDate)}
            </span>
          </p>
          {/* Told before the amount confuses them: a credit silently shrinking
              next month's bill is an unanswerable support question. */}
          {credit > 0 ? (
            <p className="mt-2 inline-block rounded-md bg-emerald-500/15 px-2.5 py-1 text-xs font-semibold text-emerald-800 dark:text-emerald-300">
              {currency(credit)} credit will be applied
            </p>
          ) : null}
        </div>

        <div className="flex w-full flex-col gap-2 sm:w-auto">
          <RoleButton className="w-full sm:w-52" onClick={onPay} tone="resident">
            <WalletCards className="size-4" />
            Pay now
          </RoleButton>
          <Button
            className="w-full rounded-xl sm:w-52"
            onClick={onSubmitProof}
            type="button"
            variant="outline"
          >
            <Upload className="size-4" />
            I&apos;ve paid — submit proof
          </Button>
        </div>
      </div>

      {/* A resident who has already submitted and sees an unchanged "pay now"
          card is the one most likely to pay twice. */}
      {pendingClaim ? (
        <p className="mt-4 flex items-start gap-2 rounded-xl bg-amber-500/15 p-3 text-sm font-semibold text-amber-800 dark:text-amber-300">
          <Loader2 className="mt-0.5 size-4 shrink-0 animate-spin" />
          You submitted {currency(pendingClaim.amount)} for this month. Your hostel is
          checking it — you do not need to pay again.
        </p>
      ) : null}

      {/* A rejection the resident is never shown is worse than no claim at all:
          they believe the month is handled, the hostel believes they were told,
          and the invoice quietly goes overdue between them. */}
      {rejectedClaim ? (
        <div className="mt-4 rounded-xl bg-rose-500/15 p-3 text-sm text-rose-800 dark:text-rose-300">
          <p className="flex items-start gap-2 font-semibold">
            <CircleAlert className="mt-0.5 size-4 shrink-0" />
            Your hostel could not accept the {currency(rejectedClaim.amount)} you
            submitted for this month.{" "}
            {/* Named, not "this month is still due". A resident who had part of
                the month accepted and part rejected reads a bare "still due" as
                *everything* still due — the sentence has to say the number. */}
            {currency(outstanding)} is still to pay.
          </p>
          {rejectedClaim.rejectionReason ? (
            <p className="mt-1.5 pl-6">Reason: {rejectedClaim.rejectionReason}</p>
          ) : null}
          <p className="mt-1.5 pl-6">
            Check the details and submit proof again, or ask your hostel office.
          </p>
        </div>
      ) : null}
    </section>
  );
}

export const ResidentPaymentsPageContent = memo(function ResidentPaymentsPageContent() {
  const [actionMessage, setActionMessage] = useState("");
  const [statusTab, setStatusTab] = useState("ALL");
  // Which invoice the resident is being told how to pay (item 3.3). "" closes
  // the panel; the same id binds the claim form, so the two halves of "pay this
  // month" cannot drift onto different invoices.
  const [payingInvoiceId, setPayingInvoiceId] = useState("");
  /**
   * The invoice the claim form is open for — the row itself, not its id.
   *
   * It was an id, resolved against `payments` on every render, with the form
   * rendered only when `payments.find(...)` matched. That made a half-filled
   * form the property of a background refresh: `payments` is a cached query that
   * any realtime invalidation re-fetches, and a single response that does not
   * carry this row unmounts the modal — with the resident's uploaded receipt and
   * typed transaction id inside it. From where they sit the screen closes by
   * itself, mid-upload, for no reason they can see.
   *
   * Holding the row means the form closes when the resident closes it and at no
   * other time. The figures are a snapshot of the moment they opened it, which
   * is what a form about "what you owe for July" wants anyway — an outstanding
   * total that changes underneath a part-filled claim is its own bug.
   */
  const [claimInvoice, setClaimInvoice] = useState<Payment | null>(null);
  const [downloading, setDownloading] = useState(false);
  const invalidate = useInvalidateResources();

  // Since item 2.8 the resident reads invoices and their own claims. `claims`
  // are `PaymentEvent` rows, which is why a claim knows its `invoiceId` rather
  // than a `paymentId`.
  const paymentsResource = usePortalResource<{
    claims: PaymentProof[];
    credit: number;
    invoices: Payment[];
  }>(residentEndpoints.payments, { errorMessage: "Could not load payments." });

  const payments = useMemo(
    () => paymentsResource.data?.invoices ?? [],
    [paymentsResource.data],
  );
  const proofs = useMemo(
    () => paymentsResource.data?.claims ?? [],
    [paymentsResource.data],
  );
  const credit = paymentsResource.data?.credit ?? 0;
  const state = paymentsResource.state;
  const message = actionMessage || paymentsResource.message;

  // Keyed by status, not last-one-wins. The API returns every claim a resident
  // has ever filed — pending, settled *and* rejected — so a single map keyed by
  // invoice handed the screen whichever claim happened to come last, and the
  // focus card then rendered "your hostel is checking it" for a claim that had
  // already been rejected. A month can also carry both: rejected, then
  // re-submitted, in which case pending is the state that matters.
  const pendingProofByPaymentId = useMemo(
    () =>
      new Map(
        proofs
          .filter((proof) => proof.status === "PENDING")
          .map((proof) => [proof.invoiceId, proof]),
      ),
    [proofs],
  );
  const rejectedProofByPaymentId = useMemo(
    () =>
      new Map(
        proofs
          .filter((proof) => proof.status === "REJECTED")
          .map((proof) => [proof.invoiceId, proof]),
      ),
    [proofs],
  );

  const stats = useMemo(() => {
    const paid = payments.filter((p) => p.status === "PAID").length;
    const unpaid = payments.filter((p) => p.status === "UNPAID").length;
    const partial = payments.filter((p) => p.status === "PARTIAL").length;
    const overdue = payments.filter((p) => p.status === "OVERDUE").length;
    const totalDue = payments.reduce(
      (sum, p) => sum + Math.max(0, p.dueAmount - p.paidAmount),
      0,
    );
    const lastPaid = payments.find((p) => p.status === "PAID");
    // Overdue first, then the earliest open month — the one they owe longest is
    // the one that should be in front of them.
    const open = payments
      .filter(
        (p) =>
          p.status === "UNPAID" || p.status === "OVERDUE" || p.status === "PARTIAL",
      )
      .sort((left, right) => openOrder(left).localeCompare(openOrder(right)));

    return {
      lastPaid,
      nextDue: open.find((p) => p.status === "OVERDUE") ?? open[0],
      overdue,
      paid,
      partial,
      totalDue,
      unpaid,
    };
  }, [payments]);

  const claimOutstanding = claimInvoice
    ? Math.max(claimInvoice.dueAmount - claimInvoice.paidAmount, 0)
    : 0;

  /**
   * Through the global downloader, which is where the fetch-blob-anchor dance
   * this used to do by hand now lives — with a progress row in the toaster on
   * top, because a statement PDF is generated server-side and the wait is long
   * enough to look like nothing happened.
   *
   * Still not a plain link, for the original reason: an `<a href>` navigates the
   * resident to a JSON error body when the generation fails.
   */
  const handleStatement = useCallback(async () => {
    setDownloading(true);

    const outcome = await downloadFile({
      fileName: "statement.pdf",
      label: "Your statement",
      mimeType: "application/pdf",
      scope: "resident-payments",
      url: residentEndpoints.statementPdf,
    });

    // The toaster already reported it; this keeps the page's own line in step
    // for anyone reading the panel rather than the corner.
    setActionMessage(outcome.ok ? "" : outcome.error);
    setDownloading(false);
  }, []);

  const filteredPayments = useMemo(() => {
    if (statusTab === "ALL") return payments;
    return payments.filter((p) => p.status === statusTab);
  }, [payments, statusTab]);

  const openClaimFor = useCallback((invoice: Payment) => {
    setClaimInvoice(invoice);
    setPayingInvoiceId("");
  }, []);

  return (
    <div className="mx-auto max-w-[1100px] space-y-6">
      <PortalPageHeader
        breadcrumb={["Home", "Payments"]}
        description="What you owe, how to pay it, and every month you have already settled."
        title="Fees & Payments"
      />
      <Message value={message} />

      {/* Standing, not a response to anything they just did — and above the fold,
          because the commonest way to fail the programme is to pay from a banking
          app having never seen the code, which until now lived only behind
          `Pay now`. Hidden when nothing is owed: a code with no invoice to quote
          it against is an instruction with no occasion. */}
      {state === "ready" && stats.nextDue ? (
        <OfferProgramBanner code={stats.nextDue.referenceCode} />
      ) : null}

      {state === "loading" ? <LoadingRows /> : null}
      {state === "error" ? <EmptyState label="Payments could not be loaded." /> : null}

      {/* ── The one thing this page is for ─────────────────────────────── */}
      {state === "ready" && stats.nextDue ? (
        <FocusCard
          credit={credit}
          onPay={() => {
            setPayingInvoiceId(stats.nextDue!.id);
            setClaimInvoice(null);
          }}
          onSubmitProof={() => openClaimFor(stats.nextDue!)}
          payment={stats.nextDue}
          pendingClaim={pendingProofByPaymentId.get(stats.nextDue.id)}
          rejectedClaim={
            pendingProofByPaymentId.has(stats.nextDue.id)
              ? undefined
              : rejectedProofByPaymentId.get(stats.nextDue.id)
          }
        />
      ) : null}

      {state === "ready" && stats.nextDue ? <ShareReceiptSteps /> : null}

      {state === "ready" && !stats.nextDue ? (
        <section className="rounded-2xl border-2 border-emerald-500/40 bg-emerald-500/5 p-6 text-center">
          <Check className="mx-auto size-8 text-emerald-600" />
          <p className="mt-2 font-heading text-lg font-bold text-foreground">
            Nothing outstanding
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Every month billed to you so far has been settled.
            {credit > 0
              ? ` You also have ${currency(credit)} in credit for your next invoice.`
              : ""}
          </p>
        </section>
      ) : null}

      {payingInvoiceId ? (
        <ResidentPayInvoicePanel
          invoiceId={payingInvoiceId}
          onClose={() => setPayingInvoiceId("")}
        />
      ) : null}

      {/* ── The claim form, only once they say they have paid (§11.2) ──── */}
      {claimInvoice ? (
        <ResidentClaimForm
          // Remounted per invoice, so a half-filled upload for July cannot be
          // submitted against August and a rejection card does not survive the
          // move to another month.
          key={claimInvoice.id}
          invoiceId={claimInvoice.id}
          month={claimInvoice.month}
          onCancel={() => setClaimInvoice(null)}
          onSubmitted={(note) => {
            setClaimInvoice(null);
            setActionMessage(note);
            invalidate(residentEndpoints.payments, residentEndpoints.dashboard);
          }}
          outstanding={claimOutstanding}
        />
      ) : null}

      {/* ── Everything else: the record ─────────────────────────────────── */}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <MetricCard
          icon={WalletCards}
          label="Total Outstanding"
          tone={stats.totalDue > 0 ? "rose" : "green"}
          trend={stats.overdue > 0 ? `${stats.overdue} month(s) overdue` : "Nothing overdue"}
          trendDown={stats.overdue > 0}
          value={currency(stats.totalDue)}
        />
        <MetricCard
          icon={CalendarDays}
          label="Next Due Date"
          tone="blue"
          /* The tile's value is one short line, so it takes the lead calendar
             alone — `Bhadra 31`. The Gregorian date is not dropped, it moves to
             the trend line beside the month the rent is for. */
          trend={
            stats.nextDue
              ? `${monthLabel(stats.nextDue.month)} · ${dayMonthYear(stats.nextDue.dueDate)}`
              : "No open dues"
          }
          value={
            stats.nextDue
              ? formatBsDayMonth(new Date(stats.nextDue.dueDate)) ||
                dayMonthYear(stats.nextDue.dueDate)
              : "—"
          }
        />
        <MetricCard
          icon={ReceiptText}
          label="Last Payment"
          tone="cyan"
          trend={stats.lastPaid ? monthLabel(stats.lastPaid.month) : "No payments yet"}
          value={stats.lastPaid ? currency(stats.lastPaid.paidAmount) : "—"}
        />
        <MetricCard
          icon={Check}
          label="Months Settled"
          tone="green"
          trend={`of ${payments.length} billed`}
          value={String(stats.paid)}
        />
      </div>

      <SectionCard
        actions={
          <Button
            className="h-9 gap-2 rounded-xl"
            disabled={downloading}
            onClick={handleStatement}
            type="button"
            variant="outline"
          >
            <Download className="size-4" />
            {downloading ? "Preparing…" : "Download Statement"}
          </Button>
        }
        title="Payment History"
      >
        <Tabs className="mb-4" onValueChange={setStatusTab} value={statusTab}>
          <TabsList className="h-auto flex-wrap rounded-xl bg-muted/50 p-1">
            <TabsTrigger className="rounded-lg px-3" value="ALL">
              All {payments.length}
            </TabsTrigger>
            <TabsTrigger className="rounded-lg px-3" value="PAID">
              Paid {stats.paid}
            </TabsTrigger>
            <TabsTrigger className="rounded-lg px-3" value="UNPAID">
              Unpaid {stats.unpaid}
            </TabsTrigger>
            <TabsTrigger className="rounded-lg px-3" value="PARTIAL">
              Partial {stats.partial}
            </TabsTrigger>
            <TabsTrigger className="rounded-lg px-3" value="OVERDUE">
              Overdue {stats.overdue}
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {state === "ready" && filteredPayments.length === 0 ? (
          <EmptyInline label="No payments in this filter." />
        ) : null}
        {state === "ready" && filteredPayments.length > 0 ? (
          <DataTable className="min-w-[820px]">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                {/* Billed, received *and* still to pay. Two of the three used to
                    be here and the resident was left to subtract them — on the
                    one row where it matters, the part-paid month, that is the
                    subtraction they came to the page to have done for them. */}
                {[
                  "Month",
                  "Billed",
                  "Received",
                  "Still to pay",
                  "Status",
                  "Due Date",
                  "Receipts",
                ].map(
                  (heading) => (
                    <TableHead
                      className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
                      key={heading}
                    >
                      {heading}
                    </TableHead>
                  ),
                )}
              </TableRow>
            </TableHeader>
            <TableBody>
              {filteredPayments.map((payment) => {
                const awaitingReview = pendingProofByPaymentId.has(payment.id);
                const isOpen =
                  payment.status === "UNPAID" ||
                  payment.status === "OVERDUE" ||
                  payment.status === "PARTIAL";
                const remaining = Math.max(payment.dueAmount - payment.paidAmount, 0);
                const receipts = payment.receipts ?? [];

                return (
                  <TableRow key={payment.id}>
                    <TableCell className="font-semibold text-foreground">
                      {monthLabel(payment.month)}
                    </TableCell>
                    <TableCell>{currency(payment.dueAmount)}</TableCell>
                    <TableCell
                      className={cn(
                        payment.paidAmount > 0
                          ? "font-semibold text-emerald-700 dark:text-emerald-400"
                          : "text-muted-foreground",
                      )}
                    >
                      {payment.paidAmount > 0 ? currency(payment.paidAmount) : "—"}
                    </TableCell>
                    <TableCell
                      className={cn(
                        remaining > 0
                          ? "font-semibold text-foreground"
                          : "text-muted-foreground",
                      )}
                    >
                      {remaining > 0 ? currency(remaining) : "—"}
                    </TableCell>
                    <TableCell>
                      <SoftBadge
                        tone={
                          awaitingReview
                            ? "amber"
                            : statusToneFromLabel(payment.status)
                        }
                      >
                        {awaitingReview
                          ? "AWAITING REVIEW"
                          : payment.status.replaceAll("_", " ")}
                      </SoftBadge>
                    </TableCell>
                    {/* Stacked, not joined: a column of two-calendar dates on
                         one line is a column nobody can scan. */}
                    <TableCell className="text-muted-foreground">
                      <span className="block font-medium text-foreground">
                        {dayMonthYearBs(payment.dueDate) ||
                          dayMonthYear(payment.dueDate)}
                      </span>
                      <span className="block text-[11px]">
                        {dayMonthYear(payment.dueDate)}
                      </span>
                    </TableCell>
                    <TableCell>
                      {/* One chip per receipt, each carrying its own amount.
                          A month settled in two payments has two receipts, and
                          the amount is what tells them apart — a resident
                          looking for the NPR 60 they paid on the 5th cannot
                          pick it out of two identical serial numbers. */}
                      <div className="flex flex-col items-start gap-1">
                        {receipts.map((receipt) => (
                          <a
                            className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-1 text-[10.5px] font-semibold text-emerald-700 transition hover:bg-emerald-500/20 dark:text-emerald-300"
                            href={residentEndpoints.receiptPdf(receipt.id)}
                            key={receipt.id}
                          >
                            <Download className="size-3" />
                            {currency(receipt.amount)}
                            <span className="font-normal opacity-80">
                              {receipt.number}
                            </span>
                          </a>
                        ))}
                        {/* A part-paid month keeps *both*: the receipts already
                            issued and the way to settle the rest. The old cell
                            was an either/or, so the row that most needs a `Pay
                            now` — the one with money still on it — was the one
                            row that lost the button as soon as a receipt
                            existed. */}
                        {isOpen ? (
                          <button
                            className="rounded-full border border-role-resident/40 bg-role-resident/10 px-2.5 py-1 text-[10.5px] font-semibold text-role-resident transition hover:bg-role-resident/20"
                            onClick={() => {
                              setPayingInvoiceId(payment.id);
                              setClaimInvoice(null);
                            }}
                            type="button"
                          >
                            {receipts.length > 0 ? "Pay the rest" : "Pay now"}
                          </button>
                        ) : null}
                        {/* Answers the question a second receipt number raises
                            before it is asked: the next payment does not rewrite
                            this receipt, it adds another one beside it. */}
                        {isOpen && receipts.length > 0 ? (
                          <span className="text-[10.5px] text-muted-foreground">
                            Paying the rest adds another receipt here.
                          </span>
                        ) : null}
                        {receipts.length === 0 && !isOpen ? (
                          <span className="text-muted-foreground">—</span>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </DataTable>
        ) : null}
      </SectionCard>
    </div>
  );
});
