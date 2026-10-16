"use client";

import { CheckCircle2, Clock3, XCircle } from "@/components/icons";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";

import {
  CHECKOUT_TOKEN_KEY,
  ProgressSteps,
  RETURN_TO_KEY,
  TransitionScreen,
} from "@/app/_components/checkout-handoff";
import { browserApi } from "@/lib/browser-api";
import type { ReturnState } from "@/modules/billing/checkout-return.service";
import type { BookingReturnState } from "@/modules/bookings/booking-softmato.service";

/**
 * Where every platform payment lands after Softmato checkout — or after not
 * paying.
 *
 * ## The steps are real
 *
 * The server streams each stage as it starts: confirming the payment with
 * Softmato, recording it, then reading back what was switched on. A payer who
 * has just handed over money watches that happen instead of a spinner, and the
 * last line is read from the plan or booking itself — not assumed.
 *
 * ## Nothing on this page is read from the URL
 *
 * The address carries our own reference (`invoice` for a plan, `booking` for a
 * booking) and nothing else. It is a navigation hint, and the answer comes from
 * a server-side call to Softmato made after ownership is checked. Softmato puts
 * no payment status in that URL, and anything resembling one did not come
 * from them.
 *
 * ## It re-checks while Softmato has not answered
 *
 * The browser usually beats the server-to-server webhook home, so a document
 * not raised yet is asked about again for a short while rather than shown as a
 * finished state.
 */

type State = ReturnState | BookingReturnState;

const POLL_MS = 4_000;
const POLL_LIMIT = 8;

const STEPS = {
  booking: [
    { id: "confirm", label: "Confirming your payment with Softmato" },
    { id: "record", label: "Recording your booking fee" },
    { id: "activate", label: "Sending your booking to the hostel" },
  ],
  plan: [
    { id: "confirm", label: "Confirming your payment with Softmato" },
    { id: "record", label: "Recording your payment and receipt" },
    { id: "activate", label: "Activating your plan" },
  ],
};

function storage(key: string) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

const day = (iso: string) =>
  new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

const moment = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", hour: "numeric", minute: "2-digit", month: "short" });

export function CheckoutReturnPage() {
  const params = useSearchParams();
  const invoiceNumber = params.get("invoice") ?? "";
  const bookingId = params.get("booking") ?? "";
  const kind = bookingId ? "booking" : "plan";
  const steps = STEPS[kind];

  const [state, setState] = useState<State | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState("");
  const [attempts, setAttempts] = useState(0);
  // Rendered on the client only (it reads the query string), so storage is there to read.
  const [back] = useState(() => {
    const saved = storage(RETURN_TO_KEY);

    // Only ever a path on this site: `//host` and `/\host` both leave it.
    if (saved && /^\/(?![/\\])/.test(saved)) return saved;

    return bookingId ? `/bookings/${encodeURIComponent(bookingId)}` : "/register-hostel";
  });

  /*
   * The no-reference case is decided from the URL rather than inside the
   * effect, so nothing calls `setState` synchronously on mount.
   */
  const missing = !invoiceNumber && !bookingId;
  // Paid from the phone app: this browser sheet is not signed in, so it only hands back.
  const toApp = params.get("via") === "app" && Boolean(bookingId);

  useEffect(() => {
    if (toApp) window.location.replace(`hostelpalika://checkout/return?booking=${encodeURIComponent(bookingId)}`);
  }, [bookingId, toApp]);

  useEffect(() => {
    if (missing || toApp) return;

    let cancelled = false;
    const token = storage(CHECKOUT_TOKEN_KEY);
    const endpoint = bookingId
      ? `/api/v1/bookings/${encodeURIComponent(bookingId)}/return`
      : `/api/v1/hostel-registration/return?invoice=${encodeURIComponent(invoiceNumber)}`;

    void (async () => {
      try {
        const result = await browserApi<{ state: State }>(
          endpoint,
          token && !bookingId ? { headers: { "x-checkout-token": token } } : undefined,
          (step) => {
            const at = steps.findIndex((candidate) => candidate.id === step);

            if (!cancelled && at >= 0) setActive((current) => Math.max(current, at));
          },
        );

        if (!cancelled) {
          // Nothing confirmed yet means nothing to tick off while we ask again.
          setActive(result.state.kind === "pending_document" ? 0 : steps.length);
          setState(result.state);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not check the payment.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [attempts, bookingId, invoiceNumber, missing, steps, toApp]);

  /*
   * Poll only while the answer can still change, and only for a while. A
   * payment that is settled or void is finished; one that is unpaid is finished
   * for now, and a reader staring at a spinner for an outcome that needs them
   * to act is worse served than one given a button.
   */
  useEffect(() => {
    const settling = state?.kind === "pending_document" || (state?.kind === "paid" && !state.activeUntil);

    if (!settling || attempts >= POLL_LIMIT) return;

    const timer = setTimeout(() => setAttempts((n) => n + 1), POLL_MS);

    return () => clearTimeout(timer);
  }, [attempts, state]);

  if (toApp) {
    return (
      <main className="mx-auto flex min-h-[70vh] w-full max-w-xl flex-col items-center justify-center px-5 py-16">
        <TransitionScreen spinning subtitle="Taking you back to the app to confirm your payment." title="Returning to the app">
          <span />
        </TransitionScreen>
      </main>
    );
  }

  const outcome = error
    ? { body: error, icon: <XCircle className="size-8 text-destructive" />, title: "We could not check that payment" }
    : missing
      ? {
          body: "This address does not name a payment. Open your account to see where things stand.",
          icon: <XCircle className="size-8 text-muted-foreground" />,
          title: "Nothing to show",
        }
      : state && state.kind !== "pending_document"
        ? describe(state)
        : null;

  const retryable = state?.kind === "unpaid" || state?.kind === "partial";

  return (
    <main className="mx-auto flex min-h-[70vh] w-full max-w-xl flex-col items-center justify-center px-5 py-16">
      {outcome ? (
        <div className="w-full rounded-2xl border border-border bg-surface p-7 text-center shadow-sm">
          <div className="mx-auto flex size-14 items-center justify-center rounded-full bg-muted/60">{outcome.icon}</div>
          <h1 className="mt-4 text-xl font-bold text-foreground">{outcome.title}</h1>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{outcome.body}</p>

          {state?.kind === "paid" || state?.kind === "booking_paid" ? (
            <div className="mx-auto mt-6 max-w-xs">
              {/* A plan still switching on keeps its last step turning while we re-check. */}
              <ProgressSteps
                active={state.kind === "paid" && !state.activeUntil ? steps.length - 1 : steps.length}
                steps={steps}
              />
            </div>
          ) : null}

          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <Link
              className="inline-flex items-center gap-2 rounded-lg bg-brand-teal px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-teal/90"
              href={back}
            >
              {retryable ? "Back to try again" : "Continue"}
            </Link>
          </div>
        </div>
      ) : (
        <TransitionScreen
          spinning
          subtitle={
            state?.kind === "pending_document"
              ? "Softmato has not confirmed this one yet. Nothing is lost — if you have paid, it shows here in a moment."
              : "Please stay on this page while we finish up. It only takes a moment."
          }
          title="Confirming your payment"
        >
          <div className="mt-7 w-full rounded-xl border border-border bg-card p-4">
            <ProgressSteps active={Math.min(active, steps.length - 1)} steps={steps} />
          </div>
        </TransitionScreen>
      )}
    </main>
  );
}

function describe(state: State): { body: string; icon: React.ReactNode; title: string } {
  switch (state.kind) {
    case "paid":
      return {
        body: state.activeUntil
          ? `${state.planName} is active until ${day(state.activeUntil)}. We will email you your receipt shortly.`
          : `We have your payment for ${state.planName}, and your plan is switching on now. We will email you your receipt shortly.`,
        icon: <CheckCircle2 className="size-8 text-success" />,
        title: state.activeUntil ? "Your plan is active" : "Payment received",
      };

    case "booking_paid":
      return {
        body: `We have your booking fee for ${state.code}. ${state.hostelName} confirms your bed${
          state.hostelAnswerBy ? ` by ${moment(state.hostelAnswerBy)}` : " shortly"
        }; if it declines or does not answer, the full fee comes back. We will email you your receipt shortly.`,
        icon: <CheckCircle2 className="size-8 text-success" />,
        title: "Booking fee received",
      };

    case "booking_refund":
      return {
        body: `Your payment for ${state.code} arrived after the booking had already ended, so nothing was booked. The full amount is being refunded to you — there is nothing you need to do.`,
        icon: <Clock3 className="size-8 text-warning" />,
        title: "Payment refunded",
      };

    case "partial":
      return {
        body: `Part of this invoice has been paid. NPR ${state.balance.toLocaleString("en-IN")} is still outstanding on ${state.planName}.`,
        icon: <Clock3 className="size-8 text-warning" />,
        title: "Partly paid",
      };

    case "unpaid":
      return {
        /*
         * Not "your payment failed". The commonest way to reach this is
         * pressing cancel at the wallet, which is a decision rather than an
         * error, and telling somebody their payment failed when they chose not
         * to make one is how a support thread starts.
         */
        body: "Nothing has been charged. You can pay whenever you are ready — the amount is unchanged.",
        icon: <Clock3 className="size-8 text-muted-foreground" />,
        title: "Not completed",
      };

    case "void":
      return {
        body: "This invoice was withdrawn, so there is nothing to pay against it. If that is unexpected, get in touch and we will look.",
        icon: <XCircle className="size-8 text-muted-foreground" />,
        title: "Invoice withdrawn",
      };

    default:
      return {
        body: "We could not find a payment under that reference for your account. If you have just paid, give it a moment and reload.",
        icon: <XCircle className="size-8 text-muted-foreground" />,
        title: "Nothing to show",
      };
  }
}
