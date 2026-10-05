"use client";

import { CalendarClock, CheckCircle2, FileText, Info, Loader2, Mail, Receipt, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore, type FormEvent } from "react";

import { formatBsAdDate } from "@hostel/shared/calendar/bs";
import {
  billingCycles,
  cycleTotal,
  getPlan,
  monthsTotal,
  planRank,
  type BillingCycle,
} from "@hostel/shared/plans/catalog";

import { useSiteConfig } from "@/components/site-config-provider";
import { Skeleton } from "@/components/ui/skeleton";
import { browserApi } from "@/lib/browser-api";
import { cn } from "@/lib/utils";
import type {
  BillingInvoiceRow,
  BillingPaymentRow,
  BillingPlan,
} from "@/modules/billing/billing-history.service";

import { CHECKOUT_TOKEN_KEY, CheckoutHandoffButton } from "./checkout-handoff";
import { Badge } from "./hostel-admin-billing-page";
import { PublicShell } from "./shared";

type PaymentState = {
  instructions: {
    amountDue: number;
    claim: { amount: number; claimedAt: string | null } | null;
    invoice: { invoiceNumber: string; planName: string } | null;
    qr: { label: string; url: string } | null;
    reference: string | null;
  };
  online: boolean;
  plan: { currentPeriodEnd: string | null; name: string | null; status: string } | null;
};

type Invoice = {
  amount: number;
  cycle: string;
  invoiceNumber: string;
  /** How many months it buys; the picker can change it while `monthsLocked` is false. */
  months?: number | null;
  monthsLocked?: boolean;
  periodEnd: string | null;
  planId: string;
  planName: string;
};

const MONTH_CHOICES = Array.from({ length: 12 }, (_, index) => index + 1);

type History = { invoices: BillingInvoiceRow[]; payments: BillingPaymentRow[]; plan: BillingPlan | null };

/** Where the plan stands once this invoice is paid in full. */
type AfterPayment = {
  cycleLabel: string;
  daysRemaining: number | null;
  /** Set when the months bought are added to a higher plan already held. */
  note: string | null;
  planName: string;
  runsUntil: string | null;
};

type Step = "details" | "code" | "pay" | "done";

const INPUT =
  "mt-1.5 h-11 w-full rounded-xl border border-border bg-background px-3.5 text-sm text-foreground outline-none transition focus:border-brand-teal focus:ring-2 focus:ring-brand-teal/15";
const PRIMARY =
  "inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-brand-teal text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-60";

function rupees(amount: number) {
  return `Rs ${amount.toLocaleString("en-IN")}`;
}

/** Bikram Sambat, the platform's one calendar: `Kartik 28, 2083 BS`. */
function day(iso: string | null) {
  return iso ? formatBsAdDate(new Date(iso)) || "—" : "—";
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : "Something went wrong. Try again.";
}

/**
 * The verified checkout, kept for this tab so a reload lands back on the pay
 * step instead of the email form. The token inside is what proves the hostel;
 * it lives an hour, and the server refuses it after that.
 */
const CHECKOUT_STATE_KEY = "hostelpalika:plan-checkout";

type SavedCheckout = { cycle: BillingCycle; planId: string; reused: boolean; token: string };

function readSavedCheckout() {
  try {
    return sessionStorage.getItem(CHECKOUT_STATE_KEY);
  } catch {
    return null;
  }
}

function forgetSavedCheckout() {
  try {
    sessionStorage.removeItem(CHECKOUT_STATE_KEY);
  } catch {
    // Nothing kept.
  }
}

// Session storage has no change event within a tab; one read per render is all this needs.
const noSubscribe = () => () => {};

function checkout<T>(body: Record<string, unknown>) {
  return browserApi<T>("/api/v1/public/plan-checkout", {
    body: JSON.stringify(body),
    method: "POST",
  });
}

/**
 * Buying a plan for a hostel already on the platform, without signing in:
 * name the hostel (email + Hostel ID), prove it with a code sent to that
 * email, then pay. Paying extends the plan that is running.
 */
export function PlanCheckoutPage({ cycle: initialCycle, planId }: { cycle: string; planId: string }) {
  const { plans: catalog } = useSiteConfig();
  const plan = getPlan(catalog, planId);
  const [cycle, setCycle] = useState<BillingCycle>(
    (["monthly", "halfYearly", "annual"] as const).find((id) => id === initialCycle) ?? "annual",
  );
  const [step, setStep] = useState<Step>("details");
  const [email, setEmail] = useState("");
  const [hostelCode, setHostelCode] = useState("");
  const [challengeId, setChallengeId] = useState("");
  const [code, setCode] = useState("");
  const [resumed, setResumed] = useState(false);
  // When "Resend code" unlocks, as a timestamp; `now` ticks while waiting.
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [token, setToken] = useState("");
  const [hostel, setHostel] = useState<{ branches?: number; code: string; name: string } | null>(null);
  const [payment, setPayment] = useState<PaymentState | null>(null);
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [reused, setReused] = useState(false);
  const [trace, setTrace] = useState<{ after: AfterPayment; history: History } | null>(null);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  /*
   * `undefined` on the server and through hydration, then the stored value —
   * read during render, so the page shows a skeleton rather than the email
   * form for a checkout it is about to restore.
   */
  const savedRaw = useSyncExternalStore(noSubscribe, readSavedCheckout, () => undefined);
  const resumable = useMemo(() => {
    if (!savedRaw) return null;

    try {
      const saved = JSON.parse(savedRaw) as SavedCheckout;

      return saved.planId === planId && saved.token ? saved : null;
    } catch {
      return null;
    }
  }, [planId, savedRaw]);
  const [restoreDone, setRestoreDone] = useState(false);
  const booting = savedRaw === undefined || (Boolean(resumable) && !restoreDone);

  function applyCheckout(
    result: PaymentState & {
      afterPayment: AfterPayment | null;
      history: History;
      invoice: Invoice | null;
    },
    context: { hostel: { branches?: number; code: string; name: string }; reused: boolean; token: string },
  ) {
    setToken(context.token);
    setHostel(context.hostel);
    setInvoice(result.invoice);
    setReused(context.reused);
    setTrace(result.afterPayment ? { after: result.afterPayment, history: result.history } : null);
    setPayment(result);
    setStep(result.instructions.claim ? "done" : "pay");
  }

  useEffect(() => {
    if (!resumable) return;

    checkout<
      PaymentState & {
        afterPayment: AfterPayment | null;
        hostel: { branches?: number; code: string; name: string };
        history: History;
        invoice: Invoice | null;
      }
    >({ step: "resume", token: resumable.token })
      .then((result) => {
        // Paid since, or nothing open: start clean rather than show an empty pay step.
        if (!result.invoice) {
          forgetSavedCheckout();

          return;
        }

        setCycle(resumable.cycle);
        applyCheckout(result, { hostel: result.hostel, reused: resumable.reused, token: resumable.token });
      })
      .catch(() => {
        // Expired or refused: the email form, as for anyone new.
        forgetSavedCheckout();
      })
      .finally(() => setRestoreDone(true));
  }, [resumable]);

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");

    try {
      await action();
    } catch (caught) {
      setError(errorText(caught));
    } finally {
      setBusy("");
    }
  }

  useEffect(() => {
    if (step !== "code" || resendAt <= Date.now()) return;

    const timer = window.setInterval(() => setNow(Date.now()), 1000);

    return () => window.clearInterval(timer);
  }, [resendAt, step]);

  const resendIn = Math.max(0, Math.ceil((resendAt - now) / 1000));

  function requestCode() {
    void run("send", async () => {
      const result = await checkout<{
        challengeId: string;
        resendInSeconds: number;
        resumed: boolean;
      }>({ email, hostelCode, step: "start" });

      setChallengeId(result.challengeId);
      setResumed(result.resumed);
      setResendAt(Date.now() + result.resendInSeconds * 1000);
      setNow(Date.now());
      setCode("");
      setStep("code");
    });
  }

  function sendCode(event: FormEvent) {
    event.preventDefault();
    requestCode();
  }

  function verify(event: FormEvent) {
    event.preventDefault();
    void run("verify", async () => {
      const verified = await checkout<PaymentState & { hostel: { branches?: number; code: string; name: string }; token: string }>({
        challengeId,
        code,
        hostelCode,
        step: "verify",
      });
      const raised = await checkout<
        PaymentState & { afterPayment: AfterPayment; history: History; invoice: Invoice; reused: boolean }
      >({
        cycle,
        // None from the footer link: the server renews the plan the hostel is on.
        planId: plan?.id,
        step: "invoice",
        token: verified.token,
      });

      // So the return page can tell a signed-out owner what happened to their money,
      // and a reload of this one comes back to the pay step.
      try {
        sessionStorage.setItem(CHECKOUT_TOKEN_KEY, verified.token);
        sessionStorage.setItem(
          CHECKOUT_STATE_KEY,
          JSON.stringify({ cycle, planId, reused: raised.reused, token: verified.token } satisfies SavedCheckout),
        );
      } catch {
        // Without it the return page asks them to sign in instead.
      }
      applyCheckout(raised, { hostel: verified.hostel, reused: raised.reused, token: verified.token });
    });
  }

  // Restoring a checkout from this tab: skeletons, never a flash of the email form.
  if (booting) {
    return (
      <PublicShell active="plans-pricing">
        <div aria-busy="true" className="mx-auto max-w-lg space-y-4 px-4 pb-20 pt-8 sm:px-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-24 rounded-2xl" />
          <Skeleton className="h-72 rounded-2xl" />
        </div>
      </PublicShell>
    );
  }

  const price = plan ? cycleTotal(plan, cycle) : 0;
  // The plan on the invoice, which the pay step can switch.
  const invoicePlan = invoice ? getPlan(catalog, invoice.planId) : undefined;
  const heldPlanId = trace?.history.plan?.planId ?? "";
  const cycleLabel = billingCycles(catalog).find((option) => option.id === cycle)?.label ?? cycle;
  const openRow = trace?.history.invoices.find((row) => row.invoiceNumber === invoice?.invoiceNumber) ?? null;
  // The open invoice is for something other than what was picked here.
  const otherPick = Boolean(plan && reused && invoice && (invoice.planName !== plan.name || invoice.cycle !== cycle));

  function reprice(change: { months: number; planId?: string }) {
    void run("months", async () => {
      const result = await checkout<
        PaymentState & { afterPayment: AfterPayment | null; history: History; invoice: Invoice | null }
      >({ ...change, step: "months", token });

      if (hostel) applyCheckout(result, { hostel, reused, token });
    });
  }

  return (
    <PublicShell active="plans-pricing">
      <div className={cn("mx-auto px-4 pb-20 pt-8 sm:px-6", trace ? "max-w-6xl" : "max-w-md sm:pt-14")}>
        {/*
          An open invoice is paid before any new plan (`raiseRenewalInvoice`),
          so once one comes back the page is about that invoice, not the pick.
        */}
        <h1 className={cn("text-2xl font-bold tracking-tight text-foreground", !invoice && "text-center")}>
          {!invoice
            ? "Pay for your hostel"
            : reused
              ? `Pay your ${invoice.planName} ${openRow?.paid ? "balance" : "invoice"}`
              : `Get ${invoice.planName}`}
        </h1>
        <p className={cn("mt-1 text-sm text-muted-foreground", !invoice && "text-center")}>
          {!invoice
            ? "Enter your hostel's email and ID. You choose the plan after the code."
            : reused
              ? `Invoice ${invoice.invoiceNumber} is still open. It is paid before any new plan.`
              : "Paying extends the plan your hostel is on now."}
        </p>

        {/* Checkout on the right, the hostel's billing trace on the left; stacked on a phone, pay first. */}
        <div
          className={cn(
            "mt-6",
            trace && "grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,34rem)] lg:items-start",
          )}
        >
          <div className="lg:col-start-2 lg:row-start-1">
            {/* The invoice being paid. Nothing to show before there is one. */}
            {invoice ? (
              <div className="app-card mb-4 p-4">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="font-semibold text-foreground">
                    {invoice.planName}
                    {openRow ? <span className="font-normal text-muted-foreground"> · {openRow.cycleLabel}</span> : null}
                  </p>
                  <p className="text-xl font-bold tabular-nums text-foreground">{rupees(invoice.amount)}</p>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Invoice {invoice.invoiceNumber} · plan runs until {day(invoice.periodEnd)}
                </p>
                {openRow && openRow.paid > 0 ? (
                  <div className="mt-3">
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-brand-teal"
                        style={{ width: `${Math.min(100, (openRow.paid / openRow.amount) * 100)}%` }}
                      />
                    </div>
                    <div className="mt-1.5 flex justify-between text-xs">
                      <span className="text-muted-foreground">Paid {rupees(openRow.paid)}</span>
                      <span className="font-semibold text-warning">{rupees(openRow.outstanding)} left</span>
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}

            <div className={cn("app-card", invoice ? "p-5" : "mt-6 p-6")}>
              {step === "details" ? (
                <form className="space-y-4" onSubmit={sendCode}>
                  <label className="block text-sm font-semibold text-foreground">
                    Hostel email
                    <input
                      autoComplete="email"
                      className={INPUT}
                      onChange={(event) => setEmail(event.target.value)}
                      placeholder="owner@yourhostel.com"
                      required
                      type="email"
                      value={email}
                    />
                  </label>
                  <div>
                    <div className="flex items-center gap-1.5">
                      <label className="text-sm font-semibold text-foreground" htmlFor="hostel-id">
                        Hostel ID
                      </label>
                      {/* Hover on desktop, tap (focus) on a phone. */}
                      <span className="group relative inline-flex">
                        <button
                          aria-describedby="hostel-id-help"
                          aria-label="Where to find your Hostel ID"
                          className="rounded-full text-muted-foreground transition hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
                          type="button"
                        >
                          <Info className="size-3.5" />
                        </button>
                        <span
                          className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-2 w-64 -translate-x-1/2 rounded-lg bg-foreground px-3 py-2 text-xs leading-relaxed text-background opacity-0 shadow-lg transition group-focus-within:opacity-100 group-hover:opacity-100"
                          id="hostel-id-help"
                          role="tooltip"
                        >
                          It looks like <strong className="font-mono">HH-3F9A1C2E</strong>. Find it on
                          the top card of the app&apos;s Home screen, or on your web dashboard.
                        </span>
                      </span>
                    </div>
                    <input
                      autoCapitalize="characters"
                      className={cn(INPUT, "font-mono uppercase tracking-wide")}
                      id="hostel-id"
                      onChange={(event) => setHostelCode(event.target.value)}
                      placeholder="HH-3F9A1C2E"
                      required
                      value={hostelCode}
                    />
                  </div>
                  <button className={PRIMARY} disabled={Boolean(busy)} type="submit">
                    {busy === "send" ? <Loader2 className="size-4 animate-spin" /> : <Mail className="size-4" />}
                    Send verification code
                  </button>
                  <p className="text-center text-xs text-muted-foreground">
                    Not on HostelPalika yet?{" "}
                    <Link
                      className="font-semibold text-brand-teal"
                      href={plan ? `/register-hostel?plan=${plan.id}` : "/register-hostel"}
                    >
                      Register your hostel
                    </Link>
                  </p>
                </form>
              ) : null}

              {step === "code" ? (
                <form className="space-y-5" onSubmit={verify}>
                  <div className="text-center">
                    <span className="mx-auto flex size-12 items-center justify-center rounded-full bg-brand-teal/10 text-brand-teal">
                      <Mail className="size-5" />
                    </span>
                    <p className="mt-3 text-lg font-bold text-foreground">Check your email</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      {resumed ? "We already sent a 6-digit code to " : "We sent a 6-digit code to "}
                      <strong className="break-all text-foreground">{email}</strong>
                      {resumed ? " a moment ago — use that one." : "."}
                    </p>
                  </div>
                  <input
                    aria-label="Verification code"
                    autoComplete="one-time-code"
                    autoFocus
                    className={cn(INPUT, "h-14 text-center font-mono text-2xl tracking-[0.5em]")}
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
                    required
                    value={code}
                  />
                  <button className={PRIMARY} disabled={Boolean(busy) || code.length !== 6} type="submit">
                    {busy === "verify" ? <Loader2 className="size-4 animate-spin" /> : <ShieldCheck className="size-4" />}
                    Verify and continue
                  </button>
                  <div className="flex items-center justify-between border-t border-border pt-4 text-xs font-semibold">
                    <button
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => setStep("details")}
                      type="button"
                    >
                      Use a different email or ID
                    </button>
                    <button
                      className="text-brand-teal disabled:text-muted-foreground"
                      disabled={resendIn > 0 || Boolean(busy)}
                      onClick={requestCode}
                      type="button"
                    >
                      {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
                    </button>
                  </div>
                </form>
              ) : null}

              {step === "pay" && payment && invoice ? (
                <div className="space-y-4">
                  {/* Where the plan stands now is in the billing panel beside this. */}
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="text-sm font-semibold text-foreground">
                      {hostel?.name} <span className="font-mono text-xs text-muted-foreground">{hostel?.code}</span>
                      {hostel?.branches ? (
                        <span className="block text-xs font-normal text-muted-foreground">
                          One plan · covers {hostel.branches} {hostel.branches === 1 ? "branch" : "branches"}
                        </span>
                      ) : null}
                    </p>
                    {/* Paying for a different hostel starts over from its email and ID. */}
                    <button
                      className="shrink-0 text-xs font-semibold text-brand-teal hover:underline"
                      onClick={() => {
                        forgetSavedCheckout();
                        setToken("");
                        setHostel(null);
                        setInvoice(null);
                        setReused(false);
                        setTrace(null);
                        setPayment(null);
                        setCode("");
                        setStep("details");
                      }}
                      type="button"
                    >
                      Another hostel
                    </button>
                  </div>

                  {/*
                    Any count 1–12 on an invoice nothing has touched: 1–5 at the
                    monthly price, 6–11 at the six-month rate, 12 at the annual.
                    Re-priced on the server; the figures here are the same function.
                  */}
                  {/*
                    Plan and months are both open on an invoice nothing has touched:
                    1–5 months at the monthly price, 6–11 at the six-month rate, 12 at
                    the annual. Re-priced on the server; the figures here are the same function.
                  */}
                  {invoice.months && !invoice.monthsLocked ? (
                    <div className="grid gap-3">
                      <label className="block text-sm font-semibold text-foreground">
                        Plan
                        <select
                          className={cn(INPUT, "font-semibold")}
                          disabled={Boolean(busy)}
                          onChange={(event) => reprice({ months: invoice.months ?? 12, planId: event.target.value })}
                          value={invoice.planId}
                        >
                          {/* Never below the plan held: those months would only extend it. */}
                          {catalog.plans.slice(Math.max(0, planRank(catalog, heldPlanId))).map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="block text-sm font-semibold text-foreground">
                        Months
                        <select
                          className={cn(INPUT, "font-semibold")}
                          disabled={Boolean(busy)}
                          onChange={(event) => reprice({ months: Number(event.target.value) })}
                          value={invoice.months}
                        >
                          {MONTH_CHOICES.map((months) => (
                            <option key={months} value={months}>
                              {months} {months === 1 ? "month" : "months"}
                              {invoicePlan ? ` · ${rupees(monthsTotal(invoicePlan, months))}` : ""}
                              {months >= 12 ? " · annual rate" : months >= 6 ? " · 6-month rate" : ""}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  ) : null}

                  {otherPick && invoice.monthsLocked ? (
                    <p className="rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-xs text-foreground">
                      You picked {plan?.name} · {cycleLabel} for {rupees(price)}. {invoice.planName} still has{" "}
                      {rupees(payment.instructions.amountDue)} left to pay, so that comes first. Get {plan?.name}{" "}
                      once it is cleared.
                    </p>
                  ) : null}

                  <p className="text-2xl font-bold tabular-nums text-foreground">
                    {rupees(payment.instructions.amountDue)}
                  </p>

                  {payment.online ? (
                    <CheckoutHandoffButton
                      back="/hostel-admin/billing"
                      body={{ step: "pay", token }}
                      className={PRIMARY}
                      endpoint="/api/v1/public/plan-checkout"
                      label={`Pay ${rupees(payment.instructions.amountDue)}`}
                      preparing="Setting up your plan payment"
                    />
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      Payment is not open right now. Contact us and we will take it for you.
                    </p>
                  )}
                </div>
              ) : null}

              {step === "done" ? (
                <div className="py-4 text-center">
                  <CheckCircle2 className="mx-auto size-10 text-success" />
                  <p className="mt-3 font-bold text-foreground">We have your payment proof</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    Our team checks it within 1–2 working days. Your plan is extended the moment it is
                    confirmed, and we email you then.
                  </p>
                </div>
              ) : null}

              {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
            </div>
          </div>

          {trace && invoice && payment ? (
            <BillingTrace
              after={trace.after}
              amountDue={payment.instructions.amountDue}
              className="lg:col-start-1 lg:row-start-1"
              history={trace.history}
            />
          ) : null}
        </div>
      </div>
    </PublicShell>
  );
}

/** The subscription's status in plain words — the enum is never printed. */
const PLAN_STATUS: Record<string, string> = {
  ACTIVE: "Active, paid",
  AWAITING_PAYMENT: "Waiting for payment",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  PAST_DUE: "Live, payment due",
  PENDING_SELECTION: "No plan chosen",
  SELECTED: "Plan chosen",
};

function daysLeft(days: number | null) {
  if (days === null) return undefined;

  return days === 0 ? "Ended" : `${days} ${days === 1 ? "day" : "days"} left`;
}

function Fact({ label, note, value }: { label: string; note?: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-semibold text-foreground">
        {value}
        {note ? <span className="block text-xs font-normal text-muted-foreground">{note}</span> : null}
      </dd>
    </div>
  );
}

/**
 * The hostel's billing beside the checkout: where the plan stands now, where it
 * stands once this is paid, and every invoice and payment behind both. The rows
 * are `getBillingHistory`'s — the same ones the portal's billing screen reads —
 * minus the PDF buttons, whose route needs a signed-in owner this page does not have.
 */
function BillingTrace({
  after,
  amountDue,
  className,
  history,
}: {
  after: AfterPayment;
  amountDue: number;
  className?: string;
  history: History;
}) {
  const { plan } = history;
  const entries = [
    ...history.invoices.map((row) => ({
      amount: row.amount,
      at: row.issuedAt,
      icon: FileText,
      key: `i-${row.invoiceNumber}`,
      note: `${row.planName} · ${row.cycleLabel}${row.outstanding > 0 ? ` · ${rupees(row.outstanding)} left` : ""}`,
      status: row.status,
      title: `Invoice ${row.printedNumber}`,
    })),
    ...history.payments.map((row, index) => ({
      amount: row.amount,
      at: row.paidAt,
      icon: Receipt,
      key: `p-${row.printedNumber ?? index}`,
      note: row.printedNumber ?? "",
      status: row.status === "IN_REVIEW" ? "IN REVIEW" : row.status,
      title:
        row.method === "CASH"
          ? "Cash payment"
          : row.method === "MANUAL"
            ? "QR payment"
            : `${row.provider ?? "Online"} payment`,
    })),
    // Newest first; a payment still in flight has no date yet and is the newest thing there is.
  ].sort((a, b) => (b.at ?? "~").localeCompare(a.at ?? "~"));

  return (
    <aside className={cn("space-y-4", className)}>
      {plan ? (
        <section className="app-card p-4">
          <h2 className="text-sm font-bold text-foreground">Your plan now</h2>
          <dl className="mt-1 divide-y divide-border">
            <Fact
              label="Plan"
              value={`${plan.planName ?? "—"}${plan.cycleLabel ? ` · ${plan.cycleLabel}` : ""}`}
            />
            <Fact label="Status" value={PLAN_STATUS[plan.status] ?? plan.status} />
            <Fact
              label="Runs until"
              note={daysLeft(plan.daysRemaining)}
              value={day(plan.currentPeriodEnd)}
            />
            {plan.amountDue > 0 && plan.dueBy ? (
              <Fact
                label="Pay by"
                note={
                  plan.daysToDue === 0
                    ? "Last day to pay"
                    : plan.daysToDue === null
                      ? undefined
                      : `${plan.daysToDue} ${plan.daysToDue === 1 ? "day" : "days"} to pay`
                }
                value={day(plan.dueBy)}
              />
            ) : null}
          </dl>
        </section>
      ) : null}

      {amountDue > 0 ? (
        <section className="app-card border-brand-teal/30 p-4">
          <h2 className="flex items-center gap-2 text-sm font-bold text-foreground">
            <CalendarClock className="size-4 text-brand-teal" />
            After you pay {rupees(amountDue)}
          </h2>
          {after.note ? <p className="mt-1 text-xs text-muted-foreground">{after.note}</p> : null}
          <dl className="mt-1 divide-y divide-border">
            <Fact label="Plan" value={`${after.planName} · ${after.cycleLabel}`} />
            <Fact label="Status" value={PLAN_STATUS.ACTIVE} />
            <Fact label="Runs until" note={daysLeft(after.daysRemaining)} value={day(after.runsUntil)} />
          </dl>
        </section>
      ) : null}

      <section>
        <h2 className="text-sm font-bold text-foreground">Billing history</h2>
        {entries.length === 0 ? (
          <p className="mt-2 rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
            Nothing billed yet.
          </p>
        ) : (
          <ul className="app-card mt-2 divide-y divide-border">
            {entries.map((entry) => (
              <li className="flex items-start gap-3 p-3.5" key={entry.key}>
                <span className="mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg bg-brand-teal/10 text-brand-teal">
                  <entry.icon className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-foreground">{entry.title}</p>
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">
                    {day(entry.at)}
                    {entry.note ? ` · ${entry.note}` : ""}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-sm font-bold tabular-nums text-foreground">{rupees(entry.amount)}</p>
                  <div className="mt-1">
                    <Badge status={entry.status} />
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </aside>
  );
}
