"use client";

import {
  ArrowUpCircle,
  CalendarClock,
  Download,
  FileText,
  LayoutList,
  Loader2,
  Receipt,
  RefreshCw,
} from "lucide-react";
import { useEffect, useState } from "react";

import { formatBsAdDate } from "@hostel/shared/calendar/bs";
import { billingCycles, cycleTotal, planRank, type BillingCycle } from "@hostel/shared/plans/catalog";

import { HostelFreeMonthCard } from "@/app/_components/hostel-free-month-card";
import { PayPlanPanel } from "@/app/_components/hostel-admin-pay-plan";
import { useSiteConfig } from "@/components/site-config-provider";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { browserApi } from "@/lib/browser-api";
import { downloadFile } from "@/lib/downloads/downloader";
import { useInvalidateResources } from "@/lib/portal-query";
import { cn } from "@/lib/utils";
import { toast } from "@/stores/toast-store";
import type {
  BillingHistory,
  BillingInvoiceRow,
  BillingPaymentRow,
  BillingPlan,
} from "@/modules/billing/billing-history.service";

/**
 * The hostel's own plan paperwork: what was billed, what was paid, and the
 * document behind each line.
 *
 * ## Two numbers on every row, and that is deliberate
 *
 * `SUB-0001-4F2A` is ours — the reference our emails quote and the one support
 * will be asked about. The other is what is *printed on the document*:
 * `INV-2083/84-000010` when Softmato raised it, `HH-INV-2083/84-000012` when
 * we did. The printed one leads, because it is what the owner is reading off
 * their copy; ours sits beside it, because showing one and hiding the other
 * guarantees the reader is looking for the one we hid.
 *
 * ## The download is a route on this app, not a link to Softmato
 *
 * Their document URL needs our client secret in a header. Sending the owner
 * there would be handing them a 401, and putting the secret in the browser to
 * fix that would publish it. So the button points at our own endpoint, which
 * checks the reader owns the hostel and then streams the bytes.
 *
 * ## Every settled row has a document now
 *
 * This screen used to say "document not raised yet" on an invoice Softmato had
 * not managed to raise, and "no gateway document" on a cash payment. Neither
 * state exists any more: when Softmato cannot be reached we issue the paper
 * ourselves, and a cash payment gets our receipt rather than nothing, because
 * money that was genuinely handed over deserves a document saying so.
 *
 * What still has no document is a payment that has not **settled** — and that
 * is not a gap. A receipt asserts that a sum was received, and one for money
 * still in flight would be a document stating something that may never be true.
 */

const STATUS_TONE: Record<string, string> = {
  OPEN: "border-warning/40 bg-warning/10 text-warning",
  PAID: "border-success/40 bg-success/10 text-success",
  PARTIAL: "border-warning/40 bg-warning/10 text-warning",
  "IN REVIEW": "border-warning/40 bg-warning/10 text-warning",
  PENDING: "border-border bg-muted/40 text-muted-foreground",
  SETTLED: "border-success/40 bg-success/10 text-success",
  VOID: "border-border bg-muted/40 text-muted-foreground",
};

const rupees = (value: number) => `NPR ${value.toLocaleString("en-IN")}`;

/**
 * The download is a fetch, not a link.
 *
 * The document route authenticates the reader and streams bytes; a plain
 * `<a href>` would send the browser off without the session this portal keeps
 * in memory, and the owner would get a login page where they expected a PDF.
 * `downloadFile` carries the credentials, shows the transfer in the global
 * toaster and never throws — the same path every other file in this portal
 * takes.
 */
function grabDocument(url: string, number: string, label: string) {
  void downloadFile({
    fileName: `${number.replace(/\//g, "-")}.pdf`,
    label,
    mimeType: "application/pdf",
    url,
  });
}

// The platform's calendar is Bikram Sambat.
const shortDate = (value: string | null) => (value ? formatBsAdDate(new Date(value)) || "—" : "—");

export function HostelAdminBillingPageContent() {
  const [history, setHistory] = useState<BillingHistory | null>(null);
  const [hostelCode, setHostelCode] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  // Bumped after a renewal is raised, so the plan card and invoices re-read.
  const [version, setVersion] = useState(0);
  const invalidate = useInvalidateResources();

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const result = await browserApi<{ history: BillingHistory; hostelCode?: string }>(
          "/api/v1/hostel-admin/billing",
        );

        if (!cancelled) {
          setHistory(result.history);
          setHostelCode(result.hostelCode ?? "");
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not load billing.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [version]);

  return (
    <div className="space-y-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold text-foreground">Plan billing</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            What this hostel has been billed for its plan, and what has been
            received. Every invoice and receipt below can be downloaded — issued
            by Softmato, who take the payment, or by us directly when they
            cannot be reached.
          </p>
        </div>
        {hostelCode ? (
          <p className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
            Hostel ID{" "}
            <strong className="select-all font-mono text-sm text-foreground">{hostelCode}</strong>
          </p>
        ) : null}
      </header>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading your billing history.
        </p>
      ) : null}

      <HostelFreeMonthCard showBillingLink={false} />

      {history?.plan ? (
        <PlanCard
          onRaised={() => {
            setVersion((current) => current + 1);
            invalidate("/api/v1/hostel-admin/billing/pay-instructions");
          }}
          plan={history.plan}
        />
      ) : null}

      {/*
        Above the paperwork, below the plan. An owner who opens this page while
        owing money opens it *to pay*; the invoices underneath are what they
        read afterwards to check it landed. It renders nothing at all when
        nothing is outstanding, which is most of the time.
      */}
      <PayPlanPanel />

      {history ? (
        <>
          <Panel
            empty="No plan invoice has been raised for this hostel yet."
            icon={<FileText className="size-4" />}
            title="Invoices"
          >
            {history.invoices.map((invoice) => (
              <InvoiceRow invoice={invoice} key={invoice.invoiceNumber} />
            ))}
          </Panel>

          <Panel
            empty="No payment has been received yet."
            icon={<Receipt className="size-4" />}
            title="Receipts"
          >
            {history.payments.map((payment, index) => (
              <PaymentRow
                key={payment.printedNumber ?? payment.receiptNumber ?? index}
                payment={payment}
              />
            ))}
          </Panel>
        </>
      ) : null}
    </div>
  );
}

/**
 * The plan, and how long is left on it.
 *
 * First on the page because it is the only thing here an owner opens this
 * screen to *decide* something about. The invoice list below is a record; this
 * is the question "am I about to lose the app".
 *
 * ## Days, and the date underneath it
 *
 * Both, and neither on its own. "17 days left" is what makes an owner act and
 * is useless for arranging a payment; "ends 14 December" is what they need to
 * put in a diary and does not convey urgency. The count leads and the date
 * qualifies it.
 *
 * The number is computed on the server (`daysUntil`) so the app and this screen
 * cannot disagree about a part-day. Rendering it here from `currentPeriodEnd`
 * would have put a second implementation of the same rounding in the browser.
 *
 * ## The tone changes once, and late
 *
 * Amber inside a fortnight, and never red. A plan approaching renewal is not a
 * fault — it is the product working — and a hostel that has paid us every year
 * does not need its billing screen shouting at it. Zero days is the state that
 * has actually gone wrong, and it says so in words rather than by turning a
 * card a colour.
 */
/** Inside this many days, the card offers to pay for the next period. */
const RENEW_WITHIN_DAYS = 7;

async function raiseRenewal(planId: string, cycle: string) {
  const result = await browserApi<{ reused: boolean }>("/api/v1/hostel-admin/billing/renew", {
    body: JSON.stringify({ cycle, planId }),
    method: "POST",
  });

  toast.success({
    description: result.reused
      ? "You already have an open plan invoice — pay that one below."
      : "Pay it below. Your plan is extended the moment it is paid.",
    title: result.reused ? "Invoice already open" : "Invoice ready",
  });
}

function failed(error: unknown) {
  toast.error({
    description: error instanceof Error ? error.message : "Try again.",
    title: "Could not raise the invoice",
  });
}

/**
 * The bigger plans, priced at the chosen cycle. Paying one switches the hostel
 * onto it and adds that cycle after the period already paid for.
 */
function UpgradeDialog({
  current,
  cycle: initialCycle,
  onClose,
  onRaised,
}: {
  current: string;
  cycle: string | null;
  onClose: () => void;
  onRaised: () => void;
}) {
  const { plans: catalog } = useSiteConfig();
  const [cycle, setCycle] = useState<BillingCycle>(
    (["monthly", "halfYearly", "annual"] as const).find((id) => id === initialCycle) ?? "monthly",
  );
  const [busy, setBusy] = useState("");
  const higher = catalog.plans.filter(
    (plan) => planRank(catalog, plan.id) > planRank(catalog, current),
  );

  async function choose(planId: string) {
    setBusy(planId);

    try {
      await raiseRenewal(planId, cycle);
      onRaised();
      onClose();
    } catch (error) {
      failed(error);
    } finally {
      setBusy("");
    }
  }

  return (
    <Dialog onOpenChange={(open) => (open ? undefined : onClose())} open>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Upgrade your plan</DialogTitle>
          <DialogDescription>
            The new plan starts when it is paid, and its time is added after your current period.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1">
          {billingCycles(catalog).map((option) => (
            <button
              className={cn(
                "rounded-md py-1.5 text-xs font-semibold transition",
                cycle === option.id ? "bg-card text-foreground shadow-sm" : "text-muted-foreground",
              )}
              key={option.id}
              onClick={() => setCycle(option.id)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
        <ul className="space-y-2">
          {higher.map((plan) => (
            <li
              className="flex items-center justify-between gap-3 rounded-xl border border-border p-3"
              key={plan.id}
            >
              <div className="min-w-0">
                <p className="font-semibold text-foreground">{plan.name}</p>
                <p className="text-xs tabular-nums text-muted-foreground">
                  {rupees(cycleTotal(plan, cycle))}
                </p>
              </div>
              <button
                className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-brand-teal px-3 text-xs font-bold text-white transition hover:brightness-110 disabled:opacity-60"
                disabled={Boolean(busy)}
                onClick={() => void choose(plan.id)}
                type="button"
              >
                {busy === plan.id ? <Loader2 className="size-3.5 animate-spin" /> : null}
                Choose
              </button>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}

function PlanCard({ onRaised, plan }: { onRaised: () => void; plan: BillingPlan }) {
  const { plans: catalog } = useSiteConfig();
  const [upgrading, setUpgrading] = useState(false);
  const [renewing, setRenewing] = useState(false);
  const days = plan.daysRemaining;
  const expiring = days !== null && days <= 14;
  const expired = days === 0;
  // Nothing may be owed: with an invoice open, that invoice is what gets paid.
  const clear = plan.amountDue <= 0 && Boolean(plan.planId);
  const canRenew = clear && Boolean(plan.cycle) && days !== null && days <= RENEW_WITHIN_DAYS;
  const canUpgrade =
    clear &&
    days !== null &&
    days > 0 &&
    catalog.plans.some((tier) => planRank(catalog, tier.id) > planRank(catalog, plan.planId ?? ""));

  async function renew() {
    setRenewing(true);

    try {
      await raiseRenewal(plan.planId ?? "", plan.cycle ?? "");
      onRaised();
    } catch (error) {
      failed(error);
    } finally {
      setRenewing(false);
    }
  }

  return (
    <section
      className={cn(
        "rounded-2xl border p-5",
        expiring ? "border-warning/40 bg-warning/5" : "border-border bg-surface",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Current plan
          </p>
          <p className="mt-1 text-lg font-bold text-foreground">
            {plan.planName ?? "No plan chosen yet"}
            {plan.cycleLabel ? (
              <span className="font-normal text-muted-foreground">
                {" \u00b7 "}
                {plan.cycleLabel}
              </span>
            ) : null}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge status={plan.status.replaceAll("_", " ")} />
            {plan.price ? (
              <span className="text-xs text-muted-foreground">
                {rupees(plan.price)} {plan.lifetime ? "paid once" : "per cycle"}
              </span>
            ) : null}
          </div>
        </div>

        {plan.lifetime ? (
          <div className="text-right">
            <p className="text-3xl font-bold text-brand-teal">For life</p>
            <p className="text-xs font-semibold text-muted-foreground">nothing to renew</p>
          </div>
        ) : days !== null ? (
          <div className="text-right">
            <p
              className={cn(
                "text-3xl font-bold tabular-nums",
                expiring ? "text-warning" : "text-foreground",
              )}
            >
              {days}
            </p>
            <p className="text-xs font-semibold text-muted-foreground">
              {days === 1 ? "day left" : "days left"}
            </p>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <CalendarClock className="size-3.5" />
        {plan.lifetime ? (
          <span>Lifetime plan — paid once, every feature of {plan.planName ?? "this plan"}, no renewals.</span>
        ) : expired ? (
          <span className="font-semibold text-warning">
            This plan has reached the end of its paid period.
          </span>
        ) : plan.currentPeriodEnd ? (
          // "Runs", not "paid", while a balance is owed: a team hostel's plan
          // starts the day it is filed, before the money is in.
          <span>
            {plan.amountDue > 0 ? "Runs" : "Paid"} through{" "}
            {shortDate(plan.currentPeriodEnd)}
          </span>
        ) : plan.amountPaid > 0 ? (
          // A part payment is money received, and saying "nothing paid" beside
          // it read as the payment having been lost.
          <span>
            Paid {rupees(plan.amountPaid)} of {rupees(plan.amountPaid + plan.amountDue)}
          </span>
        ) : (
          <span>Nothing has been paid for yet.</span>
        )}
        {plan.dueBy ? (
          <span className="font-semibold text-warning">
            Balance due by {shortDate(plan.dueBy)}
          </span>
        ) : null}

        <div className="ml-auto flex flex-wrap gap-2">
          {/* A new tab: the owner compares plans and comes back to this bill. */}
          <a
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-xs font-bold text-foreground transition hover:border-brand-teal/40"
            href="/plans-pricing"
            rel="noopener"
            target="_blank"
          >
            <LayoutList className="size-3.5" />
            See plans
          </a>
          {canUpgrade ? (
            <button
              className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-brand-teal/40 px-3 text-xs font-bold text-brand-teal transition hover:bg-brand-teal/10"
              onClick={() => setUpgrading(true)}
              type="button"
            >
              <ArrowUpCircle className="size-3.5" />
              Upgrade plan
            </button>
          ) : null}
          {canRenew ? (
            <button
              className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-brand-teal px-3 text-xs font-bold text-white transition hover:brightness-110 disabled:opacity-60"
              disabled={renewing}
              onClick={() => void renew()}
              type="button"
            >
              {renewing ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
              Pay for this plan
            </button>
          ) : null}
        </div>
      </div>

      {upgrading ? (
        <UpgradeDialog
          current={plan.planId ?? ""}
          cycle={plan.cycle}
          onClose={() => setUpgrading(false)}
          onRaised={onRaised}
        />
      ) : null}
    </section>
  );
}

function Panel({
  children,
  empty,
  icon,
  title,
}: {
  children: React.ReactNode[];
  empty: string;
  icon: React.ReactNode;
  title: string;
}) {
  return (
    <section>
      <h2 className="flex items-center gap-2 text-sm font-bold text-foreground">
        {icon}
        {title}
      </h2>

      {children.length === 0 ? (
        <p className="mt-3 rounded-xl border border-dashed border-border p-5 text-sm text-muted-foreground">
          {empty}
        </p>
      ) : (
        <ul className="mt-3 space-y-2.5">{children}</ul>
      )}
    </section>
  );
}

function InvoiceRow({ invoice }: { invoice: BillingInvoiceRow }) {
  return (
    <li className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {invoice.planName}{" "}
            <span className="font-normal text-muted-foreground">
              · {invoice.cycleLabel}
            </span>
          </p>

          {/*
            The number printed on the page leads, because that is what the owner
            is reading off their copy when they ring us. Ours sits beside it in
            the muted ink — it is the one every other screen in this portal
            indexes by, and showing only one guarantees they are holding the
            other.
          */}
          <p className="mt-1 font-mono text-xs text-foreground/70">
            {invoice.printedNumber}
            {invoice.printedNumber === invoice.invoiceNumber ? null : (
              <span className="text-muted-foreground">
                {" · "}
                {invoice.invoiceNumber}
              </span>
            )}
          </p>

          <p className="mt-1 text-xs text-muted-foreground">
            Issued {shortDate(invoice.issuedAt)}
            {invoice.dueAt ? ` · due ${shortDate(invoice.dueAt)}` : ""}
          </p>
        </div>

        <div className="text-right">
          <p className="text-lg font-bold tabular-nums text-foreground">
            {rupees(invoice.amount)}
          </p>
          {invoice.outstanding > 0 ? (
            <p className="text-xs font-semibold text-warning">
              {rupees(invoice.outstanding)} outstanding
            </p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Badge status={invoice.status} />

        {/*
          Always offered. There used to be a "document not raised yet" state
          here, for an invoice Softmato had not managed to raise — that state no
          longer exists, because we issue the document ourselves when they
          cannot, and the route resolves whichever one there is.
        */}
        <button
          className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition hover:border-brand-teal/40"
          onClick={() =>
            grabDocument(invoice.documentUrl, invoice.printedNumber, "Invoice")
          }
          type="button"
        >
          <Download className="size-3.5" />
          Invoice PDF
        </button>
      </div>
    </li>
  );
}

function PaymentRow({ payment }: { payment: BillingPaymentRow }) {
  return (
    <li className="rounded-xl border border-border bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-foreground">
            {payment.method === "CASH"
              ? "Cash, collected in person"
              : payment.method === "MANUAL"
                ? "Paid by QR, sent to us for checking"
                : (payment.provider ?? "Online payment")}
          </p>

          <p className="mt-1 font-mono text-xs text-foreground/70">
            {payment.printedNumber ?? payment.receiptNumber ?? "—"}
            {payment.receiptNumber &&
            payment.printedNumber !== payment.receiptNumber ? (
              <span className="text-muted-foreground">
                {" · "}
                {payment.receiptNumber}
              </span>
            ) : null}
          </p>

          <p className="mt-1 text-xs text-muted-foreground">
            {shortDate(payment.paidAt)}
            {payment.providerRef ? ` · ref ${payment.providerRef}` : ""}
          </p>
        </div>

        <p className="text-lg font-bold tabular-nums text-foreground">
          {rupees(payment.amount)}
        </p>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {/* `IN_REVIEW` is the one status that cannot be printed as its enum. */}
        <Badge
          status={payment.status === "IN_REVIEW" ? "IN REVIEW" : payment.status}
        />

        {payment.documentUrl ? (
          <button
            className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-xs font-semibold text-foreground transition hover:border-brand-teal/40"
            onClick={() =>
              grabDocument(
                payment.documentUrl as string,
                payment.printedNumber ?? payment.receiptNumber ?? "receipt",
                "Receipt",
              )
            }
            type="button"
          >
            <Download className="size-3.5" />
            Receipt PDF
          </button>
        ) : (
          /*
           * A receipt exists only for money that arrived. A pending or failed
           * attempt has none — not because we could not produce one, but
           * because it would assert something untrue.
           */
          <span className="text-xs text-muted-foreground">
            No receipt until this payment settles
          </span>
        )}
      </div>
    </li>
  );
}

export function Badge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        "inline-flex rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide",
        STATUS_TONE[status] ?? "border-border bg-muted/40 text-muted-foreground",
      )}
    >
      {status.toLowerCase()}
    </span>
  );
}
