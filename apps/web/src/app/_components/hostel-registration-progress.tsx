"use client";

import {
  BadgeCheck,
  Banknote,
  Check,
  Clock,
  FileText,
  Globe,
  Loader2,
  Upload,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { useSiteConfig } from "@/components/site-config-provider";
import { formatBsDate } from "@hostel/shared/calendar/bs";
import { CheckoutHandoffButton } from "@/app/_components/checkout-handoff";
import { browserApi } from "@/lib/browser-api";
import { cn } from "@/lib/utils";
import {
  bestDiscountPercent,
  billingCycles,
  cycleTotal,
  type BillingCycle,
} from "./plans-catalog";
import { useLifetimeAvailability } from "./lifetime-deal";

/**
 * The owner's progress page.
 *
 * `/register-hostel` stops being only a form once something has been submitted.
 * From then on this is what lives there: one page that says where the
 * application has got to and offers exactly the one action that is available
 * right now — and nothing else.
 *
 * ## The state machine, which is the whole component
 *
 * | application | subscription | what is offered |
 * |---|---|---|
 * | `PENDING` | no plan | browse and **choose a plan** while waiting |
 * | `PENDING` | plan chosen | the chosen plan, and "waiting on verification" |
 * | `NEEDS_MORE_INFO` | — | the **document uploader**, on this page |
 * | `APPROVED` | no plan | **choose a plan** |
 * | `APPROVED` | plan chosen | **Pay now** |
 * | — | invoice open | the **payment panel** |
 * | — | `ACTIVE` | live, with a link to the listing |
 *
 * Choosing a plan before verification is deliberate and is the reason the first
 * two rows exist separately: the wait is unavoidable, so it may as well be
 * spent on the one decision the owner can make unaided. By the time
 * verification lands there is a single button left to press.
 *
 * ## Why the gate is read from the server
 *
 * `canPayNow` is computed in `subscription.service` and sent here rather than
 * re-derived from `verified && planChosen` in the browser. There is exactly one
 * definition of when money may be taken, and a second copy of it in a component
 * is a second copy that can drift from the one the API enforces.
 */

type SubscriptionState = {
  canPayNow: boolean;
  hostelName: string;
  hostelStatus: string;
  invoice: {
    amount: number;
    cycle: string;
    documentUrl: string | null;
    dueAt: string | null;
    id: string;
    invoiceNumber: string;
    issuedAt: string | null;
    planName: string;
    status: string;
  } | null;
  outstanding: number;
  paid: number;
  payments: {
    amount: number;
    id: string;
    isMocked: boolean;
    method: string;
    receiptNumber: string | null;
    settledAt: string | null;
    status: string;
  }[];
  planChosen: boolean;
  subscription: {
    activatedAt: string | null;
    currentPeriodEnd: string | null;
    cycle: string | null;
    cycleTotal: number | null;
    dueBy: string | null;
    freeMonths?: number | null;
    freeUntil?: string | null;
    id: string;
    /** The chosen plan is the lifetime deal: paid once, no free months. */
    lifetime?: boolean;
    lifetimeSince?: string | null;
    planId: string | null;
    planName: string | null;
    source: string;
    status: string;
  };
  verified: boolean;
};

function rupees(amount: number) {
  return `Rs ${amount.toLocaleString("en-IN")}`;
}

/* ── The journey, as a row of milestones ───────────────────────────────── */

type Milestone = {
  icon: typeof Check;
  key: string;
  label: string;
};

const MILESTONES: Milestone[] = [
  { icon: FileText, key: "submitted", label: "Submitted" },
  { icon: BadgeCheck, key: "verified", label: "Verified" },
  { icon: Banknote, key: "paid", label: "Paid" },
  { icon: Globe, key: "live", label: "Live" },
];

function milestoneIndex(state: SubscriptionState | null, applicationStatus: string) {
  if (state?.subscription.status === "ACTIVE" || state?.hostelStatus === "PUBLISHED") {
    return 3;
  }

  if (state && state.paid > 0 && state.outstanding <= 0) {
    return 2;
  }

  if (applicationStatus === "APPROVED" || state?.verified) {
    return 1;
  }

  return 0;
}

function Journey({ reached }: { reached: number }) {
  return (
    <ol className="flex items-center gap-1 overflow-x-auto pb-1">
      {MILESTONES.map((milestone, index) => {
        const done = index <= reached;
        const Icon = milestone.icon;

        return (
          <li className="flex flex-1 items-center gap-1" key={milestone.key}>
            <div className="flex min-w-max flex-col items-center gap-1.5">
              <span
                className={cn(
                  "flex size-9 items-center justify-center rounded-full border transition-colors",
                  done
                    ? "animate-marker-settle border-brand-teal bg-brand-teal text-white"
                    : "border-border bg-surface text-muted-foreground",
                )}
              >
                <Icon className="size-4" />
              </span>
              <span
                className={cn(
                  "whitespace-nowrap text-[11px] font-semibold",
                  done ? "text-foreground" : "text-muted-foreground",
                )}
              >
                {milestone.label}
              </span>
            </div>
            {index < MILESTONES.length - 1 ? (
              <span
                className={cn(
                  "mb-5 h-0.5 flex-1 rounded-full",
                  index < reached ? "bg-brand-teal" : "bg-border",
                )}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

/* ── Choosing a plan ───────────────────────────────────────────────────── */

/**
 * The real catalogue, from the same site-config section the public pricing page
 * renders.
 *
 * The form used to carry three plans hardcoded into the file, with prices that
 * had already drifted from what `/plans-pricing` quoted. An owner comparing the
 * two pages saw two different numbers for the same product, and the one they
 * were about to be charged was the one nobody was maintaining.
 */
function PlanPicker({
  busy,
  currentCycle,
  currentLifetime,
  currentPlanId,
  onDirtyChange,
  onSelect,
}: {
  busy: boolean;
  currentCycle: string | null;
  /** The plan chosen is the lifetime deal. */
  currentLifetime: boolean;
  currentPlanId: string | null;
  /** True while a picked plan is waiting on Confirm — Pay now must not charge the old one. */
  onDirtyChange?: (dirty: boolean) => void;
  onSelect: (planId: string, cycle: BillingCycle, lifetime: boolean) => void;
}) {
  const { plans: catalog } = useSiteConfig();
  const cycles = billingCycles(catalog);
  const savedCycle = cycles.find((option) => option.id === currentCycle)?.id ?? null;
  const [cycle, setCycle] = useState<BillingCycle>(savedCycle ?? "monthly");
  /*
   * A card press picks, it does not save. Saving on every press raised a new
   * selection server-side each time an owner was only comparing, the same way
   * the Regular / Lifetime switch already worked locally. Confirm saves it.
   */
  const [draft, setDraft] = useState<{ lifetime: boolean; planId: string } | null>(
    currentPlanId ? { lifetime: currentLifetime, planId: currentPlanId } : null,
  );
  const dirty =
    draft !== null &&
    (draft.planId !== currentPlanId ||
      draft.lifetime !== currentLifetime ||
      (!draft.lifetime && savedCycle !== null && cycle !== savedCycle));
  const draftName = draft ? catalog.plans.find((plan) => plan.id === draft.planId)?.name : null;

  // Whatever the server now holds — on first load, and after a Confirm — is the pick.
  useEffect(() => {
    setDraft(currentPlanId ? { lifetime: currentLifetime, planId: currentPlanId } : null);
  }, [currentLifetime, currentPlanId]);

  useEffect(() => {
    if (savedCycle) setCycle(savedCycle);
  }, [savedCycle]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const priced = catalog.plans.filter((plan) => plan.monthly > 0);
  /*
   * The lifetime deal, while it is on sale: a separate switch rather than a
   * fourth cycle, because it is a different purchase — paid once, in full,
   * with no free months. The cards then show its prices and seats.
   */
  const { availability } = useLifetimeAvailability();
  const lifetimeOffers = availability?.window === "open" ? availability.offers : [];
  const [lifetimeMode, setLifetimeMode] = useState(currentLifetime);
  const onLifetime = lifetimeMode && lifetimeOffers.length > 0;

  if (priced.length === 0) {
    return (
      <p className="rounded-lg border border-border bg-muted/40 p-4 text-sm text-muted-foreground">
        No plans are published yet. We will email you as soon as they are.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      {lifetimeOffers.some((offer) => offer.left > 0) || (currentLifetime && lifetimeOffers.length > 0) ? (
        <div className="grid grid-cols-2 gap-2 sm:inline-grid sm:w-auto">
          {(
            [
              [false, "Regular plan", "Free months, then monthly"],
              [true, "Lifetime deal", "Pay once · every feature, for life"],
            ] as const
          ).map(([value, label, note]) => (
            <button
              className={cn(
                "rounded-lg border px-3 py-2 text-left transition",
                onLifetime === value
                  ? "border-brand-teal bg-brand-teal/10"
                  : "border-border hover:border-brand-teal/40",
              )}
              key={label}
              onClick={() => setLifetimeMode(value)}
              type="button"
            >
              <span className="block text-xs font-bold text-foreground">{label}</span>
              <span className="block text-[11px] text-muted-foreground">{note}</span>
            </button>
          ))}
        </div>
      ) : null}

      {onLifetime ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {priced.flatMap((plan) => {
            const offer = lifetimeOffers.find((entry) => entry.planId === plan.id);

            if (!offer) return [];

            const selected = draft?.lifetime === true && plan.id === draft.planId;
            const soldOut = offer.left <= 0;

            return [
              <button
                className={cn(
                  "rounded-xl border p-4 text-left transition disabled:cursor-not-allowed disabled:opacity-50",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-teal/40",
                  selected
                    ? "border-brand-teal bg-brand-teal/5 ring-1 ring-brand-teal/30"
                    : "border-border bg-surface hover:border-brand-teal/40",
                  busy && "pointer-events-none opacity-60",
                )}
                disabled={busy || (soldOut && !(currentLifetime && plan.id === currentPlanId))}
                key={plan.id}
                onClick={() => setDraft({ lifetime: true, planId: plan.id })}
                type="button"
              >
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm font-bold text-foreground">{plan.name} · Lifetime</p>
                  {selected ? (
                    <span className="flex size-5 items-center justify-center rounded-full bg-brand-teal text-white">
                      <Check className="size-3" strokeWidth={3} />
                    </span>
                  ) : null}
                </div>
                <p className="mt-2 text-lg font-bold tabular-nums text-foreground">
                  {rupees(offer.price)}
                  <span className="ml-1 text-xs font-medium text-muted-foreground">once</span>
                </p>
                <p className={cn("mt-1 text-xs font-semibold", soldOut ? "text-muted-foreground" : "text-brand-teal")}>
                  {soldOut ? "Sold out" : `${offer.left} of ${offer.seats} seats left`}
                </p>
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  Every feature of {plan.name}, for life. No free months — it starts the day you pay.
                </p>
              </button>,
            ];
          })}
        </div>
      ) : null}

      <div className={cn("inline-flex rounded-lg border border-border bg-muted/50 p-1", onLifetime && "hidden")}>
        {cycles.map((option) => {
          // The best discount across the plans, not one plan's — the badge sits
          // on the toggle, above every card, so a figure taken from one of them
          // would be contradicted by the other two.
          const saving = bestDiscountPercent(catalog, option.id);

          return (
            <button
              className={cn(
                "rounded-md px-3 py-1.5 text-xs font-semibold transition",
                cycle === option.id
                  ? "bg-surface text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
              )}
              key={option.id}
              onClick={() => setCycle(option.id)}
              type="button"
            >
              {option.label}
              {saving > 0 ? (
                <span className="ml-1 text-brand-teal">−{saving}%</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div className={cn("grid gap-3 sm:grid-cols-2 lg:grid-cols-3", onLifetime && "hidden")}>
        {priced.map((plan) => {
          const selected = draft?.lifetime === false && plan.id === draft.planId;
          const total = cycleTotal(plan, cycle);

          return (
            <button
              className={cn(
                "rounded-xl border p-4 text-left transition",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-teal/40",
                selected
                  ? "border-brand-teal bg-brand-teal/5 ring-1 ring-brand-teal/30"
                  : "border-border bg-surface hover:border-brand-teal/40",
                busy && "pointer-events-none opacity-60",
              )}
              disabled={busy}
              key={plan.id}
              onClick={() => setDraft({ lifetime: false, planId: plan.id })}
              type="button"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="text-sm font-bold text-foreground">{plan.name}</p>
                {selected ? (
                  <span className="flex size-5 items-center justify-center rounded-full bg-brand-teal text-white">
                    <Check className="size-3" strokeWidth={3} />
                  </span>
                ) : null}
              </div>

              {plan.freeMonths ? (
                <p className="mt-2 text-xs font-semibold text-brand-teal">
                  First {plan.freeMonths} {plan.freeMonths === 1 ? "month" : "months"} free, then
                </p>
              ) : null}
              <p className={cn("text-lg font-bold tabular-nums text-foreground", plan.freeMonths ? "mt-0.5" : "mt-2")}>
                {rupees(total)}
                <span className="ml-1 text-xs font-medium text-muted-foreground">
                  / {cycles.find((option) => option.id === cycle)?.label.toLowerCase()}
                </span>
              </p>

              {plan.description ? (
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                  {plan.description}
                </p>
              ) : null}
            </button>
          );
        })}
      </div>

      {dirty && draft ? (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-brand-teal/30 bg-brand-teal/5 p-3">
          <p className="flex-1 text-sm text-foreground">
            <strong className="font-semibold">
              {draftName}
              {draft.lifetime ? " · Lifetime" : ""}
            </strong>{" "}
            is picked. Confirm to save it.
          </p>
          {currentPlanId ? (
            <button
              className="rounded-lg px-3 py-2 text-xs font-semibold text-muted-foreground transition hover:text-foreground"
              disabled={busy}
              onClick={() => {
                setDraft({ lifetime: currentLifetime, planId: currentPlanId });
                if (savedCycle) setCycle(savedCycle);
              }}
              type="button"
            >
              Keep current plan
            </button>
          ) : null}
          <button
            className="inline-flex items-center gap-2 rounded-lg bg-brand-teal px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-teal/90 disabled:opacity-60"
            disabled={busy}
            onClick={() => onSelect(draft.planId, cycle, draft.lifetime)}
            type="button"
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            Confirm plan
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ── Paying ────────────────────────────────────────────────────────────── */

function PaymentPanel({
  busy,
  hostelId,
  state,
}: {
  busy: boolean;
  hostelId: string;
  state: SubscriptionState;
}) {
  const invoice = state.invoice;

  if (!invoice) {
    return null;
  }

  /*
   * One press hands the owner to Softmato checkout — see `checkout-handoff`.
   * Nothing this component does can mark an invoice paid: money is confirmed
   * by a signed webhook from Softmato, and by a server-side read on the page
   * the owner comes back to. The session is minted on the press, never ahead.
   */
  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-border bg-muted/30 p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Invoice {invoice.invoiceNumber}
            </p>
            <p className="mt-1 text-sm font-semibold text-foreground">
              {invoice.planName}
            </p>
          </div>
          <p className="text-2xl font-bold tabular-nums text-foreground">
            {rupees(state.outstanding)}
          </p>
        </div>

        {state.paid > 0 ? (
          <p className="mt-2 text-xs text-muted-foreground">
            {rupees(state.paid)} already received.
          </p>
        ) : null}
      </div>

      {busy ? null : (
        <CheckoutHandoffButton
          className="w-full sm:w-auto"
          endpoint={`/api/v1/hostel-registration/${hostelId}/pay`}
          label={`Pay ${rupees(state.outstanding)}`}
          preparing="Setting up your plan payment"
        />
      )}
    </div>
  );
}

/* ── The page ──────────────────────────────────────────────────────────── */

export function HostelRegistrationProgress({
  application,
  documentSlot,
  onRefresh,
}: {
  application: {
    hostelId: string;
    hostelName: string;
    status: "APPROVED" | "NEEDS_MORE_INFO" | "PENDING" | "REJECTED";
  };
  /** The requested-documents uploader, passed in so its logic stays in one place. */
  documentSlot?: React.ReactNode;
  onRefresh: () => Promise<void> | void;
}) {
  const { identity } = useSiteConfig();
  const [state, setState] = useState<SubscriptionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const fetchState = useCallback(async () => {
    try {
      return await browserApi<{ state: SubscriptionState | null }>(
        `/api/v1/hostel-registration/${application.hostelId}/state`,
      );
    } catch {
      // A billing read that fails must not blank the status page — the
      // application's own status is still worth showing on its own.
      return { state: null };
    }
  }, [application.hostelId]);

  /**
   * Reloads after an action the user just took.
   *
   * Separate from the mount effect below because the two differ in what they
   * have to guard against: this one is called from a handler that has already
   * finished, the other one races an unmount.
   */
  const load = useCallback(async () => {
    const result = await fetchState();

    setState(result.state);
    setLoading(false);
  }, [fetchState]);

  useEffect(() => {
    let cancelled = false;

    void (async () => {
      const result = await fetchState();

      // A reply that lands after the owner has navigated away must not write
      // state into an unmounted tree.
      if (cancelled) {
        return;
      }

      setState(result.state);
        setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [fetchState]);

  const [planDirty, setPlanDirty] = useState(false);

  async function choosePlan(planId: string, cycle: BillingCycle, lifetime: boolean) {
    setBusy(true);
    setError("");

    try {
      const result = await browserApi<{ state: SubscriptionState }>(
        `/api/v1/hostel-registration/${application.hostelId}/plan`,
        {
          body: JSON.stringify({ cycle, planId, ...(lifetime ? { lifetime: true } : {}) }),
          method: "POST",
        },
      );

      setState(result.state);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that plan.");
    } finally {
      setBusy(false);
    }
  }

  async function payNow() {
    setBusy(true);
    setError("");

    try {
      const result = await browserApi<{ state: SubscriptionState }>(
        `/api/v1/hostel-registration/${application.hostelId}/invoice`,
        { method: "POST" },
      );

      setState(result.state);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not raise the invoice.");
    } finally {
      setBusy(false);
    }
  }

  const reached = milestoneIndex(state, application.status);
  const live = state?.subscription.status === "ACTIVE";
  const invoiceOpen =
    state?.invoice && ["OPEN", "PARTIAL"].includes(state.invoice.status);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8 md:px-6">
      <header>
        <h1 className="text-2xl font-bold tracking-tight text-foreground">
          {application.hostelName}
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Everything about your registration lives on this page.
        </p>
      </header>

      <div className="rounded-2xl border border-border bg-surface p-5 shadow-sm md:p-6">
        <Journey reached={reached} />
      </div>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {/* Documents we still need — the only thing that matters while it is true. */}
      {application.status === "NEEDS_MORE_INFO" && documentSlot ? (
        <section className="animate-step-in rounded-2xl border border-warning/40 bg-warning/5 p-5 shadow-sm md:p-6">
          <div className="flex items-center gap-2">
            <Upload className="size-4 text-warning" />
            <h2 className="text-base font-bold text-foreground">
              We need a few more documents
            </h2>
          </div>
          <div className="mt-4">{documentSlot}</div>
        </section>
      ) : null}

      {loading ? (
        <div className="rounded-2xl border border-border bg-surface p-6 shadow-sm">
          <div className="h-4 w-40 animate-pulse rounded bg-muted" />
          <div className="mt-3 h-3 w-64 animate-pulse rounded bg-muted" />
        </div>
      ) : live ? (
        <section className="animate-step-in rounded-2xl border border-brand-teal/30 bg-brand-teal/5 p-6 shadow-sm">
          <div className="flex items-center gap-2">
            <Globe className="size-5 text-brand-teal" />
            <h2 className="text-lg font-bold text-foreground">Your listing is live</h2>
          </div>
          {state?.subscription.freeUntil ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Your {state.subscription.planName} plan is free for{" "}
              {state.subscription.freeMonths}{" "}
              {state.subscription.freeMonths === 1 ? "month" : "months"}, until{" "}
              {formatBsDate(new Date(state.subscription.freeUntil))} — no need to recharge
              until then. After that, recharge this hostel yourself from Billing in your
              dashboard
              {identity.supportPhone ? `, or call us on ${identity.supportPhone}` : ""}.
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              {state?.subscription.planName} is active
              {state?.subscription.lifetimeSince
                ? " for life — paid once, nothing to renew"
                : state?.subscription.currentPeriodEnd
                ? ` until ${new Date(state.subscription.currentPeriodEnd).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}`
                : ""}
              . You can manage everything from your dashboard.
            </p>
          )}
        </section>
      ) : (
        <section className="animate-step-in rounded-2xl border border-border bg-surface p-5 shadow-sm md:p-6">
          {!state?.verified ? (
            <div className="mb-6 flex items-start gap-3 rounded-xl border border-border bg-muted/40 p-4">
              <Clock className="mt-0.5 size-4 shrink-0 text-brand-teal" />
              <div>
                <p className="text-sm font-semibold text-foreground">
                  We are checking your details
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  This usually takes 1–2 business days, and we will email you the
                  moment it is done. In the meantime you can pick the plan you want —
                  you will not be charged until your hostel is verified.
                </p>
              </div>
            </div>
          ) : null}

          {invoiceOpen ? (
            <>
              <h2 className="text-base font-bold text-foreground">Pay for your plan</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Your listing goes live the moment this is paid.
              </p>
              <div className="mt-5">
                <PaymentPanel
                  busy={busy}
                  hostelId={application.hostelId}
                  state={state!}
                />
              </div>

              {/*
                * Coming back from checkout, the browser usually beats the
                * webhook home. So an owner who has genuinely paid can land here
                * still looking at an unpaid invoice for a second or two. This
                * is the button that stops that being alarming — they can ask
                * again rather than paying twice.
                */}
              <button
                className="mt-4 inline-flex items-center gap-2 text-xs font-semibold text-muted-foreground underline-offset-4 transition hover:text-foreground hover:underline"
                disabled={busy}
                onClick={async () => {
                  /*
                   * Ask Softmato first, then reload. The return endpoint does a
                   * server-side read of their ledger and settles anything we
                   * have not recorded — which is how a payment gets provisioned
                   * on a machine no webhook can reach. Reloading without it
                   * would only re-render the same stale state.
                   */
                  if (state?.invoice) {
                    await browserApi(
                      `/api/v1/hostel-registration/return?invoice=${encodeURIComponent(state.invoice.invoiceNumber)}`,
                    ).catch(() => null);
                  }

                  await load();
                  await onRefresh();
                }}
                type="button"
              >
                Already paid? Check again
              </button>
            </>
          ) : (
            <>
              <h2 className="text-base font-bold text-foreground">
                {state?.planChosen ? "Your plan" : "Choose your plan"}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {state?.planChosen
                  ? "You can change this until you pay."
                  : "Pick the one that suits you. You can change it later."}
              </p>

              <div className="mt-5">
                <PlanPicker
                  busy={busy}
                  currentCycle={state?.subscription.cycle ?? null}
                  currentLifetime={Boolean(state?.subscription.lifetime)}
                  currentPlanId={state?.subscription.planId ?? null}
                  onDirtyChange={setPlanDirty}
                  onSelect={choosePlan}
                />
              </div>

              {state?.canPayNow ? (
                <>
                  <button
                    className="mt-6 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-brand-teal px-5 py-3 text-sm font-semibold text-white transition hover:bg-brand-teal/90 disabled:opacity-60 sm:w-auto"
                    disabled={busy || planDirty}
                    title={planDirty ? "Confirm the plan you picked first" : undefined}
                    onClick={payNow}
                    type="button"
                  >
                    {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                    Pay now
                    {state.subscription.cycleTotal
                      ? ` — ${rupees(state.subscription.cycleTotal)}`
                      : ""}
                  </button>
                  {/* The portal waits for the payment (`approvePlatformHostel`),
                      and the verified email said the same — so this says it
                      here too, where the owner is looking for the next step. */}
                  <p className="mt-3 text-sm text-muted-foreground">
                    We have emailed you about this, please check your email. Your hostel
                    portal opens as soon as the payment is complete.
                  </p>
                </>
              ) : state?.planChosen ? (
                <p className="mt-6 rounded-lg border border-border bg-muted/40 p-3 text-sm text-muted-foreground">
                  <strong className="font-semibold text-foreground">
                    {state.subscription.planName}
                    {state.subscription.lifetime ? " · Lifetime" : ""}
                  </strong>{" "}
                  {state.subscription.lifetime
                    ? "is saved — one payment, for life, with no free months. Pay now appears here as soon as your details are verified."
                    : state.subscription.freeMonths
                    ? `is saved. Its ${state.subscription.freeMonths} free ${state.subscription.freeMonths === 1 ? "month starts" : "months start"} the day your details are verified — nothing to pay now.`
                    : "is saved. Pay now appears here as soon as your details are verified."}
                </p>
              ) : null}
            </>
          )}
        </section>
      )}

      {state && state.payments.length > 0 ? (
        <section className="rounded-2xl border border-border bg-surface p-5 shadow-sm md:p-6">
          <h2 className="text-base font-bold text-foreground">Payments</h2>
          <ul className="mt-3 divide-y divide-border">
            {state.payments.map((payment) => (
              <li
                className="flex items-center justify-between gap-3 py-2.5 text-sm"
                key={payment.id}
              >
                <span className="text-muted-foreground">
                  {payment.settledAt
                    ? new Date(payment.settledAt).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                        year: "numeric",
                      })
                    : "Pending"}
                  {payment.receiptNumber ? ` · ${payment.receiptNumber}` : ""}
                </span>
                <span className="font-semibold tabular-nums text-foreground">
                  {rupees(payment.amount)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
