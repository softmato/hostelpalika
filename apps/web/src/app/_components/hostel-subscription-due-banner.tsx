"use client";

import { AlertTriangle, Clock, Lock, X } from "@/components/icons";
import Link from "next/link";
import { useEffect, useState } from "react";

import { useCheckoutHandoff } from "@/app/_components/checkout-handoff";
import { browserApi } from "@/lib/browser-api";
import { hostelDaysBetween } from "@hostel/shared/calendar/bs";

/**
 * "Please pay this much within N days" — the due a team registration leaves
 * behind.
 *
 * ## Why it is a banner and not a page
 *
 * A hostel in this state is **live**. Its listing is up, students can find it,
 * and it is being run day to day by somebody who did not necessarily make the
 * payment arrangement — the owner met an agent once and an amount was agreed.
 * So the reminder has to be somewhere they cannot miss on the way to doing
 * something else, which is the top of every screen.
 *
 * ## The button opens a checkout; it never records a payment
 *
 * `Pay now` hands the owner to Softmato checkout (`checkout-handoff`), and the
 * money is confirmed by Softmato's webhook or the return page's server-side
 * read. **A browser cannot record a payment** — an earlier version of this
 * button "confirmed" one on a second press, and told the owner so.
 *
 * ## It knows when a claim is already in review
 *
 * A balance stays outstanding while we are checking a proof, so without this
 * the banner would keep asking an owner who paid this morning to pay again.
 *
 * ## Why it cannot be dismissed permanently
 *
 * Closing it hides it for the session and no longer. A due with a deadline that
 * a hostel could switch off is a due nobody pays; the dismissal exists so
 * somebody can get through one piece of work without it in the way, not so they
 * can decide never to see it.
 *
 * ## It renders nothing in every other state
 *
 * A hostel that paid in full, one that predates plan billing, one whose
 * registration is still public and unpublished — all of them get no banner at
 * all. Only `PAST_DUE` with money actually outstanding produces one.
 */

type State = {
  invoice: { id: string; invoiceNumber: string } | null;
  outstanding: number;
  /** Every attempt against the plan. Read for one thing: an `IN_REVIEW` row. */
  payments?: { status: string }[];
  subscription: { dueBy: string | null; planName: string | null; status: string };
};

function rupees(amount: number) {
  return `Rs ${amount.toLocaleString("en-IN")}`;
}

/**
 * Nepal days from today to the deadline's day — 0 on the day itself, negative
 * once it has passed.
 *
 * Between days, not milliseconds. The ceiling this replaces read a due at the
 * end of Bhadra 29 as "4 days" on the morning of Bhadra 26, while the billing
 * screen beside it said 3; both now take the day count the server uses.
 */
function daysUntil(iso: string) {
  return hostelDaysBetween(new Date(), new Date(iso));
}

export function HostelSubscriptionDueBanner() {
  const [state, setState] = useState<State | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const handoff = useCheckoutHandoff();

  useEffect(() => {
    async function load() {
      try {
        const result = await browserApi<{
          state: (State & { subscription: { id: string } }) | null;
        }>("/api/v1/hostel-admin/subscription");

        setState(result.state);
      } catch {
        // A banner that cannot load its own data shows nothing. It is a
        // reminder, not a gate — failing loudly here would put an error across
        // the top of every screen in the portal.
        setState(null);
      }
    }

    void load();
  }, []);

  if (
    dismissed ||
    !state ||
    state.subscription.status !== "PAST_DUE" ||
    state.outstanding <= 0
  ) {
    return null;
  }

  const remaining = state.subscription.dueBy ? daysUntil(state.subscription.dueBy) : null;
  const overdue = remaining !== null && remaining < 0;
  const reviewing = Boolean(
    state.payments?.some((payment) => payment.status === "IN_REVIEW"),
  );

  return (
    <div className="mb-4 rounded-lg border border-warning/40 bg-warning/10 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <AlertTriangle className="size-4 shrink-0 text-warning" />

        <p className="min-w-0 flex-1 text-sm text-foreground">
          <strong className="font-semibold">
            {rupees(state.outstanding)} is due for your{" "}
            {state.subscription.planName ?? "plan"}
          </strong>
          {reviewing
            ? " — we have your proof and are checking it."
            : remaining === null
              ? "."
              : overdue
                ? ` — it was due ${Math.abs(remaining)} ${Math.abs(remaining) === 1 ? "day" : "days"} ago.`
                : remaining === 0
                  ? " — today is the last day to pay."
                  : ` — please pay within ${remaining} ${remaining === 1 ? "day" : "days"}.`}{" "}
          <span className="text-muted-foreground">
            {reviewing
              ? "We will email you within 1–2 working days. Your listing stays live."
              : "Your listing stays live in the meantime."}
          </span>
        </p>

        {/*
          Paying is one press now: Softmato checkout opens straight from here.
          A proof already in review still links to billing to see its status.
        */}
        {reviewing ? (
          <Link
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-warning px-3 py-1.5 text-xs font-bold text-white transition hover:brightness-110"
            href="/hostel-admin/billing"
          >
            <Clock className="size-3.5" />
            See the status
          </Link>
        ) : (
          <button
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-warning px-3 py-1.5 text-xs font-bold text-white transition hover:brightness-110 disabled:opacity-60"
            disabled={handoff.busy}
            onClick={() =>
              void handoff.start({
                endpoint: "/api/v1/hostel-admin/billing/checkout",
                preparing: "Setting up your plan payment",
              })
            }
            type="button"
          >
            <Lock className="size-3.5" />
            Pay now
          </button>
        )}
        {handoff.overlay}

        <button
          aria-label="Hide until next visit"
          className="shrink-0 rounded p-1 text-muted-foreground transition hover:text-foreground"
          onClick={() => setDismissed(true)}
          type="button"
        >
          <X className="size-4" />
        </button>
      </div>

    </div>
  );
}
