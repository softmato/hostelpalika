"use client";

import { AlertTriangle, BadgeCheck, Copy, Check, Sparkles } from "@/components/icons";
import { useCallback, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * The Resident Offer Program — one name, one promise, said the same way
 * everywhere on Fees & Payments.
 *
 * **What it actually is:** the reference code, given a reason the resident cares
 * about. Everything downstream of a payment depends on the code travelling with
 * it — statement matching, auto-settlement, an owner's queue that is not full of
 * transfers nobody can attribute — and none of that is the resident's problem.
 * "Your payment is harder for us to match" is our problem stated as their
 * obligation, and people ignore it. A programme they stay in by quoting a code
 * they already have is a reason of their own, and it buys exactly the behaviour
 * that makes reconciliation possible.
 *
 * **Why one module rather than a paragraph per screen.** The programme is
 * mentioned at five different moments — the page banner, the pay screen, before
 * the upload, and the two answers after it — and a promise that is worded
 * slightly differently each time is not a promise, it is marketing. The states
 * live in one union here so the name, the tone and the instruction cannot drift
 * apart, and adding a sixth moment is a case in this file rather than a fresh
 * invention on a screen.
 *
 * **Never a gate, in any state.** A resident whose bank strips the remarks field
 * has still paid their rent. The worst thing any of these says is "next time".
 */

export const OFFER_PROGRAM_NAME = "Resident Offer Program";

export type OfferProgramState =
  /** They are about to pay and the code has to travel with the money. */
  | "reminder"
  /** The route they are using attaches the code itself — nothing for them to do. */
  | "automatic"
  /** We read their receipt and the code is on it. */
  | "confirmed"
  /** We read their receipt and it is not. */
  | "missed"
  /** This invoice was never allocated a code, so the programme cannot apply. */
  | "unavailable";

/** The programme's mark. Small, so it can sit in a modal header without shouting. */
export function OfferProgramBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border border-role-resident/40 bg-role-resident/10 px-2.5 py-1 text-[11px] font-bold text-role-resident",
        className,
      )}
    >
      <Sparkles aria-hidden className="size-3" />
      {OFFER_PROGRAM_NAME}
    </span>
  );
}

function CodeChip({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = useCallback(() => {
    // `writeText` rejects on an insecure origin and inside some in-app browsers.
    // The label simply does not flip rather than the button appearing to work.
    void navigator.clipboard
      ?.writeText(code)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => setCopied(false));
  }, [code]);

  return (
    <button
      aria-label={`Copy reference code ${code}`}
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-lg border px-2.5 py-1 font-mono text-[12.5px] font-bold tracking-wider transition",
        copied
          ? "border-emerald-500/50 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-current/30 bg-background/60 hover:bg-background",
      )}
      onClick={copy}
      type="button"
    >
      {code}
      {copied ? (
        <Check aria-hidden className="size-3 opacity-70" />
      ) : (
        <Copy aria-hidden className="size-3 opacity-70" />
      )}
    </button>
  );
}

/** Everything that differs between the states, in one table rather than five branches. */
const TONES: Record<
  OfferProgramState,
  { box: string; icon: typeof Sparkles; iconClass: string }
> = {
  automatic: {
    box: "border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
    icon: BadgeCheck,
    iconClass: "text-emerald-600 dark:text-emerald-400",
  },
  confirmed: {
    box: "border-emerald-500/40 bg-emerald-500/10 text-emerald-900 dark:text-emerald-200",
    icon: BadgeCheck,
    iconClass: "text-emerald-600 dark:text-emerald-400",
  },
  missed: {
    box: "border-amber-500/50 bg-amber-500/15 text-amber-900 dark:text-amber-200",
    icon: AlertTriangle,
    iconClass: "text-amber-600 dark:text-amber-400",
  },
  reminder: {
    box: "border-role-resident/40 bg-role-resident/5 text-foreground",
    icon: Sparkles,
    iconClass: "text-role-resident",
  },
  unavailable: {
    box: "border-border bg-muted/40 text-foreground",
    icon: Sparkles,
    iconClass: "text-muted-foreground",
  },
};

/**
 * The programme, said at one of the five moments it comes up.
 *
 * `code` is required by every state but `unavailable`, which exists precisely
 * because there is no code to name.
 */
export function OfferProgramCallout({
  className,
  code,
  compact = false,
  state,
}: {
  className?: string;
  code?: string | null;
  /** Drops the heading line — for rails and modals that already carry a header. */
  compact?: boolean;
  state: OfferProgramState;
}) {
  const tone = TONES[state];
  const Icon = tone.icon;

  return (
    <div
      className={cn("rounded-xl border-2 p-3", tone.box, className)}
      role={state === "missed" || state === "confirmed" ? "status" : undefined}
      {...(state === "missed" || state === "confirmed"
        ? { "aria-live": "polite" as const }
        : {})}
    >
      {compact ? null : (
        <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide">
          <Icon aria-hidden className={cn("size-3.5", tone.iconClass)} />
          {OFFER_PROGRAM_NAME}
        </p>
      )}

      {state === "unavailable" ? (
        <p className={cn("text-[12.5px] leading-5", compact ? "" : "mt-1.5")}>
          This month has no reference code, so it cannot count towards the
          programme. Write your full name in the remarks instead and submit your
          receipt — your hostel will match it by hand.
        </p>
      ) : null}

      {state === "reminder" && code ? (
        <div className={cn(compact ? "" : "mt-2")}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[12.5px] font-semibold">
              Put this code in the remarks:
            </span>
            <CodeChip code={code} />
          </div>
          <p className="mt-1.5 text-[11.5px] leading-4 opacity-80">
            Payments carrying your code are matched to you automatically, confirmed
            faster, and keep you in the programme.
          </p>
        </div>
      ) : null}

      {state === "automatic" ? (
        <p className={cn("text-[12.5px] leading-5", compact ? "" : "mt-1.5")}>
          <span className="font-semibold">Nothing to do here.</span> Paying this way
          attaches your code{code ? ` (${code})` : ""} for you, so this payment
          counts towards the programme on its own.
        </p>
      ) : null}

      {state === "confirmed" && code ? (
        <div className={cn(compact ? "" : "mt-1.5")}>
          <p className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-semibold">
            <BadgeCheck aria-hidden className="size-4 shrink-0" />
            Your code <span className="font-mono tracking-wider">{code}</span> is on
            this receipt.
          </p>
          <p className="mt-1 pl-5 text-[11.5px] leading-4 opacity-90">
            Your hostel can match this payment automatically, and you stay in the
            programme.
          </p>
        </div>
      ) : null}

      {state === "missed" && code ? (
        <div className={cn(compact ? "" : "mt-1.5")}>
          <p className="flex flex-wrap items-center gap-1.5 text-[12.5px] font-bold">
            <AlertTriangle aria-hidden className="size-4 shrink-0" />
            We could not find your code{" "}
            <span className="font-mono tracking-wider">{code}</span> on this receipt.
          </p>
          <p className="mt-1 pl-5 text-[11.5px] leading-4">
            Next time, type it in the remarks or purpose field before you send —
            that is what keeps you in the programme.
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 pl-5">
            <CodeChip code={code} />
            <span className="text-[11.5px] opacity-90">
              You can still submit this one — your hostel will match it by hand.
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * The page-level strip on Fees & Payments.
 *
 * Deliberately quieter than the callouts: it is the standing explanation, not a
 * response to anything the resident just did. It carries the code for the month
 * they owe, because the commonest way to fail the programme is to pay from a
 * banking app without ever having seen the code.
 */
export function OfferProgramBanner({ code }: { code?: string | null }) {
  return (
    <section className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border/70 bg-card px-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-role-team-soft text-role-team">
          <Sparkles aria-hidden className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="font-heading text-[15px] font-semibold text-foreground">
            {OFFER_PROGRAM_NAME}
          </p>
          <p className="truncate text-[13px] text-muted-foreground">
            Put your reference code in the payment remarks.
          </p>
        </div>
      </div>
      {code ? (
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Your code
          </span>
          <CodeChip code={code} />
        </div>
      ) : null}
    </section>
  );
}
