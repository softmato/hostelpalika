"use client";

import { CheckCircle2, Circle, Loader2, Lock, ShieldCheck, XCircle } from "@/components/icons";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { BrandMark } from "@/components/brand-mark";
import { browserApi } from "@/lib/browser-api";
import { cn } from "@/lib/utils";

/**
 * Handing a payer over to Softmato's checkout — the one way money reaches the
 * platform from any screen here (resident rent excepted: that is the hostel's
 * money and never touches this rail).
 *
 * ## The progress is the server's, not an animation
 *
 * The endpoint streams a line as each piece of real work *starts* (see
 * `progressResponse`): reading the invoice, opening the session. The list
 * below moves when those lines arrive and at no other time, so what the payer
 * reads is what is happening. The first step is the one the browser itself can
 * vouch for — the request reaching an authenticated server — and the last is
 * the redirect, in this same tab.
 *
 * ## Same tab, and a way back
 *
 * The page they return to reads `RETURN_TO_KEY` for its Continue button, so
 * they land back where they pressed Pay rather than on a generic dashboard.
 * Session storage belongs to this tab and survives the round trip to
 * Softmato's origin; when it is unavailable the return page has a default.
 */

export const RETURN_TO_KEY = "softmato:return-to";
/** A public plan checkout's token, for a return page whose reader is signed out. */
export const CHECKOUT_TOKEN_KEY = "softmato:checkout-token";

export type ProgressStep = { id: string; label: string };

type Handoff = {
  back?: string;
  body?: unknown;
  /** POST endpoint that streams progress and ends with `{ checkoutUrl }`. */
  endpoint: string;
  /** Instead of just closing the overlay, when the payer dismisses a failure. */
  onClose?: () => void;
  /** The endpoint answered, just before the redirect — to keep anything it returned. */
  onOpened?: (result: Record<string, unknown>) => void;
  /** The session step, in the payer's terms: "Setting up your plan payment". */
  preparing?: string;
};

const ORDER = ["connect", "invoice", "session", "redirect"];

export function ProgressSteps({
  active,
  failed = false,
  steps,
}: {
  active: number;
  failed?: boolean;
  steps: ProgressStep[];
}) {
  return (
    <ol aria-live="polite" className="w-full space-y-3 text-left">
      {steps.map((step, index) => {
        const state =
          index < active ? "done" : index > active ? "waiting" : failed ? "failed" : "active";

        return (
          <li
            className={cn(
              "flex items-center gap-3 text-sm transition-colors duration-300",
              state === "waiting" ? "text-muted-foreground/60" : "text-foreground",
            )}
            key={step.id}
          >
            {state === "done" ? (
              <CheckCircle2 className="size-5 shrink-0 text-brand-teal" />
            ) : state === "active" ? (
              <Loader2 className="size-5 shrink-0 animate-spin text-brand-teal" />
            ) : state === "failed" ? (
              <XCircle className="size-5 shrink-0 text-destructive" />
            ) : (
              <Circle className="size-5 shrink-0" />
            )}
            <span className={cn(state === "active" && "font-semibold")}>{step.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** The full-screen transition, in the same shape as the Google sign-in one. */
export function TransitionScreen({
  children,
  error,
  spinning,
  subtitle,
  title,
}: {
  children: React.ReactNode;
  error?: boolean;
  spinning: boolean;
  subtitle: string;
  title: string;
}) {
  return (
    <div className="flex w-full max-w-sm flex-col items-center text-center">
      <div className="relative mb-8 flex size-20 items-center justify-center rounded-2xl bg-brand-teal/10 text-brand-teal shadow-inner">
        <BrandMark className={cn("h-8", spinning && "animate-pulse")} />
        {spinning ? (
          <div className="absolute -inset-2.5 animate-spin rounded-3xl border-2 border-brand-teal/20 border-t-brand-teal" />
        ) : null}
      </div>
      <h3 className="font-heading text-xl font-bold tracking-tight text-foreground" id="handoff-title">
        {title}
      </h3>
      <p className={cn("mt-2 text-sm", error ? "text-destructive" : "text-muted-foreground")}>{subtitle}</p>
      {children}
    </div>
  );
}

export function useCheckoutHandoff() {
  const [run, setRun] = useState<{ active: number; error: string; handoff: Handoff } | null>(null);

  /*
   * Pressing Back on Softmato's page can restore this one from the
   * back-forward cache exactly as it was left: mid-redirect, spinner and all.
   */
  useEffect(() => {
    const reset = (event: PageTransitionEvent) => {
      if (event.persisted) setRun(null);
    };

    window.addEventListener("pageshow", reset);

    return () => window.removeEventListener("pageshow", reset);
  }, []);

  async function start(handoff: Handoff) {
    setRun({ active: 0, error: "", handoff });

    try {
      const opened = await browserApi<{ checkoutUrl: string } & Record<string, unknown>>(
        handoff.endpoint,
        {
          body: handoff.body === undefined ? undefined : JSON.stringify(handoff.body),
          method: "POST",
        },
        (step) => {
          const at = ORDER.indexOf(step);

          if (at > 0) setRun((current) => current && { ...current, active: Math.max(current.active, at) });
        },
      );

      handoff.onOpened?.(opened);

      try {
        sessionStorage.setItem(RETURN_TO_KEY, handoff.back ?? window.location.pathname + window.location.search);
      } catch {
        // Private mode or blocked storage: the return page falls back to its default.
      }

      setRun((current) => current && { ...current, active: ORDER.length - 1 });
      window.location.assign(opened.checkoutUrl);
    } catch (error) {
      setRun(
        (current) =>
          current && {
            ...current,
            error: error instanceof Error ? error.message : "Could not open the checkout.",
          },
      );
    }
  }

  // Portalled: a fixed layer inside a blurred or transformed header would be
  // positioned against that header, not the screen.
  const overlay = run ? createPortal(
    <HandoffOverlay
      active={run.active}
      error={run.error}
      onClose={() => {
        setRun(null);
        run.handoff.onClose?.();
      }}
      onRetry={() => void start(run.handoff)}
      preparing={run.handoff.preparing}
    />,
    document.body,
  ) : null;

  return { busy: Boolean(run && !run.error), overlay, start };
}

function HandoffOverlay({
  active,
  error,
  onClose,
  onRetry,
  preparing = "Setting up your payment",
}: {
  active: number;
  error: string;
  onClose: () => void;
  onRetry: () => void;
  preparing?: string;
}) {
  const retry = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (error) retry.current?.focus();
  }, [error]);

  const steps = [
    { id: "connect", label: "Making a secure connection" },
    { id: "invoice", label: "Reading your invoice" },
    { id: "session", label: preparing },
    { id: "redirect", label: "Opening Softmato checkout" },
  ];

  return (
    <div
      aria-labelledby="handoff-title"
      aria-modal="true"
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-background/95 px-6 backdrop-blur-sm animate-in fade-in duration-300"
      role="dialog"
    >
      <TransitionScreen
        error={Boolean(error)}
        spinning={!error}
        subtitle={
          error ||
          "You finish paying on Softmato, our company's checkout, in this same tab — then come straight back here."
        }
        title={error ? "The checkout did not open" : "Preparing your secure checkout"}
      >
        <div className="mt-7 w-full rounded-xl border border-border bg-card p-4">
          <ProgressSteps active={active} failed={Boolean(error)} steps={steps} />
        </div>

        {error ? (
          <div className="mt-6 flex gap-3">
            <button
              className="rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground transition hover:border-brand-teal/40"
              onClick={onClose}
              type="button"
            >
              Close
            </button>
            <button
              className="rounded-lg bg-brand-teal px-4 py-2 text-sm font-bold text-white transition hover:brightness-110"
              onClick={onRetry}
              ref={retry}
              type="button"
            >
              Try again
            </button>
          </div>
        ) : (
          <div className="mt-7 flex items-center gap-2 rounded-full border border-brand-teal/20 bg-brand-teal/10 px-3 py-1.5 text-[12px] font-semibold text-brand-teal">
            <ShieldCheck className="size-4" />
            <span>Secured by Softmato</span>
          </div>
        )}
      </TransitionScreen>
    </div>
  );
}

/** The Pay button every platform payment uses, with its hand-off built in. */
export function CheckoutHandoffButton({
  className,
  hint = true,
  label,
  ...handoff
}: Handoff & { className?: string; /** The "taken to Softmato" line under it; off inside a list row. */ hint?: boolean; label: string }) {
  const { busy, overlay, start } = useCheckoutHandoff();

  return (
    <div>
      <button
        className={cn(
          "inline-flex items-center justify-center gap-2 rounded-lg bg-brand-teal px-5 py-2.5 text-sm font-bold text-white transition hover:brightness-110 disabled:opacity-60",
          className,
        )}
        disabled={busy}
        onClick={() => void start(handoff)}
        type="button"
      >
        <Lock className="size-4" />
        {label}
      </button>
      {hint ? (
        <p className="mt-2 text-xs text-muted-foreground">
          You will be taken to Softmato, our company&apos;s secure checkout, and brought back here when it is done.
        </p>
      ) : null}
      {overlay}
    </div>
  );
}
