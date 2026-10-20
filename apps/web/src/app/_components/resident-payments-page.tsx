"use client";

import {
  Check,
  CircleAlert,
  Download,
  Loader2,
  ReceiptText,
  Upload,
  WalletCards,
} from "@/components/icons";
import { memo, useCallback, useMemo, useState } from "react";

import { currency, EmptyState } from "@/app/_components/shared-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { Button } from "@/components/ui/button";
import { ResidentClaimForm } from "@/app/_components/resident-claim-form";
import { ShareReceiptSteps } from "@/app/_components/share-receipt-steps";
import { ResidentPayInvoicePanel } from "@/app/_components/resident-pay-invoice-panel";
import { dayMonthYear, dayMonthYearBs, monthLabel } from "@/lib/format-month";
import { bsPeriodOf } from "@hostel/shared/calendar/bs";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { downloadFile } from "@/lib/downloads/downloader";
import { residentEndpoints } from "@/lib/resident-endpoints";
import {
  AmountCard,
  CardSkeletons,
  FactChip,
  SectionTitle,
  ShareBar,
  titleCase,
} from "./daily-portal-ui";
import { OfferProgramBanner } from "./resident-offer-program";
import { type Payment, type PaymentProof, Message } from "./resident-shared";
import {
  EmptyInline,
  MetricCard,
  PortalPageHeader,
  RoleButton,
  SectionCard,
  SoftBadge,
  statusToneFromLabel,
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
  payment,
  pendingClaim,
  rejectedClaim,
}: {
  credit: number;
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
  const partlyPaid = payment.paidAmount > 0 && outstanding > 0;

  return (
    <AmountCard
      amount={outstanding}
      dueDate={payment.dueDate}
      /* **The big number is labelled.** It is the *remaining* balance, not the
         month's rent, and on a part-paid month the two differ — a resident who
         paid NPR 60 of NPR 1,290 was shown a bare "NPR 1,230" and had no way to
         tell which of the two numbers it was. */
      label={`${partlyPaid ? "Still to pay" : "Amount due"} · ${monthLabel(payment.month)}`}
      note={
        partlyPaid || credit > 0 ? (
          <span className="flex flex-wrap gap-1.5">
            {/* The arithmetic as chips. Every part-paid month raises the same
                question — *where did my payment go* — and the answer is a
                subtraction the resident can check against their bank app. */}
            {partlyPaid ? (
              <>
                <FactChip glyph="receipt">{`${currency(payment.dueAmount)} billed`}</FactChip>
                <FactChip glyph="checkmark-circle" tone="brand">
                  {`${currency(payment.paidAmount)} received`}
                </FactChip>
              </>
            ) : null}
            {/* Told before the amount confuses them: a credit silently shrinking
                next month's bill is an unanswerable support question. */}
            {credit > 0 ? (
              <FactChip glyph="wallet" tone="brand">{`${currency(credit)} credit applies`}</FactChip>
            ) : null}
          </span>
        ) : null
      }
    >
      {/* A resident who has already submitted and sees an unchanged card is the
          one most likely to pay twice. */}
      {pendingClaim ? (
        <p className="flex items-center gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-[13px] font-semibold text-amber-800 dark:bg-amber-950/40 dark:text-amber-300">
          <Loader2 className="size-4 shrink-0 animate-spin" />
          {currency(pendingClaim.amount)} sent — your hostel is checking it. No need to pay again.
        </p>
      ) : null}

      {/* A rejection the resident is never shown is worse than no claim at all:
          they believe the month is handled, the hostel believes they were told,
          and the invoice quietly goes overdue between them. The sentence names
          the number still owed, because a bare "still due" reads as everything. */}
      {rejectedClaim ? (
        <div className="rounded-xl bg-rose-50 px-3 py-2.5 text-[13px] text-rose-800 dark:bg-rose-950/40 dark:text-rose-300">
          <p className="flex items-center gap-2 font-semibold">
            <CircleAlert className="size-4 shrink-0" />
            {currency(rejectedClaim.amount)} was not accepted. {currency(outstanding)} is still to pay.
          </p>
          {rejectedClaim.rejectionReason ? (
            <p className="mt-1 pl-6">Reason: {rejectedClaim.rejectionReason}</p>
          ) : null}
        </div>
      ) : null}
    </AmountCard>
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
    <div className="mx-auto max-w-[1100px] space-y-5">
      <PortalPageHeader
        actions={
          <>
            <Button
              className="h-9 gap-2 rounded-xl"
              disabled={downloading}
              onClick={handleStatement}
              type="button"
              variant="outline"
            >
              <Download className="size-4" />
              {downloading ? "Preparing…" : "Statement"}
            </Button>
            {stats.nextDue ? (
              <>
                <Button
                  className="h-9 gap-2 rounded-xl"
                  onClick={() => openClaimFor(stats.nextDue!)}
                  type="button"
                  variant="outline"
                >
                  <Upload className="size-4" />
                  I&apos;ve paid
                </Button>
                <RoleButton
                  className="h-9 px-4"
                  onClick={() => {
                    setPayingInvoiceId(stats.nextDue!.id);
                    setClaimInvoice(null);
                  }}
                  tone="team"
                >
                  <WalletCards className="size-4" />
                  Pay now
                </RoleButton>
              </>
            ) : null}
          </>
        }
        description="What you owe and every month you have paid."
        title="Fees & Payments"
      />
      <Message value={message} />

      {state === "loading" ? <CardSkeletons count={3} /> : null}
      {state === "error" ? <EmptyState label="Payments could not be loaded." /> : null}

      {/* ── The one thing this page is for ─────────────────────────────── */}
      {state === "ready" && stats.nextDue ? (
        <div className="grid gap-4 lg:grid-cols-[1.3fr_1fr]">
          <FocusCard
            credit={credit}
            payment={stats.nextDue}
            pendingClaim={pendingProofByPaymentId.get(stats.nextDue.id)}
            rejectedClaim={
              pendingProofByPaymentId.has(stats.nextDue.id)
                ? undefined
                : rejectedProofByPaymentId.get(stats.nextDue.id)
            }
          />
          <div className="grid content-start gap-3">
            {/* Above the fold, because the commonest way to fail the programme
                is to pay from a banking app having never seen the code. Hidden
                when nothing is owed: a code with no invoice is an instruction
                with no occasion. */}
            <OfferProgramBanner code={stats.nextDue.referenceCode} />
            <ShareReceiptSteps />
          </div>
        </div>
      ) : null}

      {state === "ready" && !stats.nextDue ? (
        <AmountCard
          amount={0}
          label="Nothing outstanding"
          note={credit > 0 ? `${currency(credit)} credit for your next bill.` : "Every bill so far is paid."}
        />
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
      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard
          icon={WalletCards}
          label="Total outstanding"
          note={stats.overdue > 0 ? `${stats.overdue} month(s) overdue` : "Nothing overdue"}
          noteTone={stats.overdue > 0 ? "rose" : "teal"}
          tone={stats.overdue > 0 ? "rose" : "teal"}
          value={currency(stats.totalDue)}
        />
        <MetricCard
          icon={ReceiptText}
          label="Last payment"
          note={stats.lastPaid ? monthLabel(stats.lastPaid.month) : "None yet"}
          value={stats.lastPaid ? currency(stats.lastPaid.paidAmount) : "—"}
        />
        <MetricCard
          icon={Check}
          label="Months paid"
          note={`of ${payments.length} billed`}
          value={String(stats.paid)}
        />
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between gap-3">
          <SectionTitle>History</SectionTitle>
          <FilterButton active={statusTab === "ALL" ? 0 : 1} onClear={() => setStatusTab("ALL")}>
            <FilterChoice
              label="Status"
              onChange={setStatusTab}
              options={[
                { label: `All ${payments.length}`, value: "ALL" },
                { label: `Paid ${stats.paid}`, value: "PAID" },
                { label: `Unpaid ${stats.unpaid}`, value: "UNPAID" },
                { label: `Partial ${stats.partial}`, value: "PARTIAL" },
                { label: `Overdue ${stats.overdue}`, value: "OVERDUE" },
              ]}
              value={statusTab}
            />
          </FilterButton>
        </div>

        <SectionCard>
          {state === "ready" && filteredPayments.length === 0 ? (
            <EmptyInline label="No months in this filter." />
          ) : null}
          <div className="divide-y divide-border/60">
            {filteredPayments.map((payment) => {
              const awaitingReview = pendingProofByPaymentId.has(payment.id);
              const isOpen =
                payment.status === "UNPAID" ||
                payment.status === "OVERDUE" ||
                payment.status === "PARTIAL";
              const remaining = Math.max(payment.dueAmount - payment.paidAmount, 0);
              const receipts = payment.receipts ?? [];

              return (
                <div
                  className="flex flex-col gap-3 py-3.5 first:pt-0 last:pb-0 md:flex-row md:items-center md:gap-5"
                  key={payment.id}
                >
                  <div className="flex min-w-0 items-center gap-3 md:w-56 md:shrink-0">
                    <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-foreground">
                      <ReceiptText className="size-[18px]" />
                    </span>
                    <div className="min-w-0">
                      <p className="truncate text-[13.5px] font-semibold text-foreground">
                        {monthLabel(payment.month)}
                      </p>
                      <p className="truncate text-[12px] text-muted-foreground">
                        Due {dayMonthYearBs(payment.dueDate) || dayMonthYear(payment.dueDate)}
                      </p>
                    </div>
                  </div>

                  {/* Billed, received *and* still to pay: on the part-paid month
                      that subtraction is what they came here for. */}
                  <ShareBar
                    className="min-w-0 flex-1"
                    label={
                      remaining > 0
                        ? `${currency(payment.paidAmount)} of ${currency(payment.dueAmount)} · ${currency(remaining)} left`
                        : `${currency(payment.dueAmount)} paid`
                    }
                    total={payment.dueAmount}
                    tone={payment.status === "OVERDUE" ? "wrong" : "brand"}
                    value={payment.paidAmount}
                  />

                  <div className="flex flex-wrap items-center gap-1.5 md:w-64 md:shrink-0 md:justify-end">
                    <SoftBadge tone={awaitingReview ? "amber" : statusToneFromLabel(payment.status)}>
                      {awaitingReview ? "Awaiting review" : titleCase(payment.status)}
                    </SoftBadge>
                    {/* One chip per receipt, each with its own amount: a month
                        paid in two goes has two receipts, and the amount is
                        what tells them apart. */}
                    {receipts.map((receipt) => (
                      <a
                        className="inline-flex items-center gap-1 rounded-full bg-role-team-soft px-2 py-0.5 text-[10.5px] font-semibold text-role-team transition hover:bg-role-team/15"
                        href={residentEndpoints.receiptPdf(receipt.id)}
                        key={receipt.id}
                        title={receipt.number}
                      >
                        <Download className="size-3" />
                        {currency(receipt.amount)}
                      </a>
                    ))}
                    {/* A part-paid month keeps both: its receipts and the way
                        to settle the rest. */}
                    {isOpen ? (
                      <button
                        className="rounded-full bg-foreground px-2.5 py-0.5 text-[10.5px] font-semibold text-background transition hover:opacity-85"
                        onClick={() => {
                          setPayingInvoiceId(payment.id);
                          setClaimInvoice(null);
                        }}
                        title={receipts.length > 0 ? "Paying the rest adds another receipt." : undefined}
                        type="button"
                      >
                        {receipts.length > 0 ? "Pay the rest" : "Pay"}
                      </button>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>
        </SectionCard>
      </div>
    </div>
  );
});
