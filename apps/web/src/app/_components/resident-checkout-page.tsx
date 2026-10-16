"use client";

import { AlertTriangle, ArrowLeft, CheckCircle2, Loader2, XCircle } from "@/components/icons";
import Link from "next/link";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import { PortalPageHeader, SectionCard } from "@/app/_components/portal-dashboard-ui";
import { currency } from "@/app/_components/shared-ui";
import { browserApi } from "@/lib/browser-api";
import { residentEndpoints } from "@/lib/resident-endpoints";

/**
 * Where the resident lands after leaving the provider (target §11.6, item 6.2).
 *
 * **This screen has no authority over money and is written to make that
 * obvious.** Its URL is guessable and carries nothing; every state it shows
 * comes from the server, which got it by asking the provider directly. A
 * resident who reloads it, shares it, or reaches it without paying sees exactly
 * what the provider says — which, for someone who did not pay, is nothing.
 *
 * The one thing it must never do is imply a payment succeeded because the
 * provider's redirect said so. Providers append their own outcome to the return
 * URL, and it is trivially editable; `?outcome=failed` is used only to soften
 * the wording while polling, never to conclude anything.
 */

type CheckoutStatus = {
  amount: number;
  expiresAt: string;
  invoiceId: string;
  provider: string;
  reference: string;
  sandbox: boolean;
  settled: boolean;
  status: string;
};

/** Slow enough to be kind to the provider, fast enough not to feel broken. */
const POLL_MS = 2500;
/** Roughly two minutes. Past this, a resident is better served by a real answer. */
const MAX_POLLS = 48;

export const ResidentCheckoutPageContent = memo(function ResidentCheckoutPageContent({
  reference,
}: {
  reference: string;
}) {
  const [status, setStatus] = useState<CheckoutStatus | null>(null);
  const [error, setError] = useState("");
  const [givenUp, setGivenUp] = useState(false);
  const polls = useRef(0);

  const load = useCallback(async () => {
    try {
      setStatus(
        await browserApi<CheckoutStatus>(residentEndpoints.checkoutStatus(reference)),
      );
    } catch (cause) {
      setError((cause as Error).message || "Could not check this payment.");
    }
  }, [reference]);

  useEffect(() => {
    void load();

    const timer = setInterval(() => {
      polls.current += 1;

      if (polls.current > MAX_POLLS) {
        setGivenUp(true);
        clearInterval(timer);
        return;
      }

      void load();
    }, POLL_MS);

    return () => clearInterval(timer);
  }, [load]);

  // Only the server's own answer stops the polling. A provider's redirect
  // parameters never reach this decision.
  const settled = status?.settled === true;
  const failed = status?.status === "FAILED" || status?.status === "EXPIRED";
  const waiting = !settled && !failed;

  useEffect(() => {
    if (settled || failed) {
      polls.current = MAX_POLLS + 1;
    }
  }, [failed, settled]);

  return (
    <div className="space-y-5">
      <PortalPageHeader
        description={`Reference ${reference}`}
        title="Payment status"
      />

      <SectionCard title={settled ? "Payment received" : "Checking your payment"}>
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            {settled ? (
              <CheckCircle2 aria-hidden="true" className="mt-0.5 size-6 text-emerald-600" />
            ) : failed ? (
              <XCircle aria-hidden="true" className="mt-0.5 size-6 text-destructive" />
            ) : (
              <Loader2 aria-hidden="true" className="mt-0.5 size-6 animate-spin" />
            )}
            <div className="space-y-1">
              <p className="font-semibold">
                {settled
                  ? "Your payment is recorded."
                  : failed
                    ? "This payment did not go through."
                    : "Confirming with your payment provider…"}
              </p>
              <p className="text-sm leading-5 text-muted-foreground">
                {settled
                  ? "Your invoice is updated and your receipt is ready. Nothing else is needed from you."
                  : failed
                    ? "No money has left your account for this attempt. You can try again, or use one of the manual methods."
                    : "This can take a few seconds. Please do not pay again while it finishes — if the payment went through, it will appear here on its own."}
              </p>
            </div>
          </div>

          {status ? (
            <dl className="grid gap-3 rounded-lg bg-muted/50 p-3 text-sm sm:grid-cols-3">
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Amount
                </dt>
                <dd className="font-bold">{currency(status.amount)}</dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Method
                </dt>
                <dd className="font-semibold capitalize">
                  {status.provider.toLowerCase()}
                </dd>
              </div>
              <div>
                <dt className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Reference
                </dt>
                <dd className="font-mono font-semibold">{status.reference}</dd>
              </div>
            </dl>
          ) : null}

          {status?.sandbox ? (
            <p className="flex items-start gap-2 rounded-lg bg-amber-500/15 p-3 text-sm font-semibold text-amber-800 dark:text-amber-300">
              <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              Test mode — this attempt used a sandbox merchant and moved no real money.
            </p>
          ) : null}

          {/* Timing out is not a verdict. The sweep keeps asking the provider
              long after this screen has stopped, so a payment that succeeded
              still lands on the invoice. */}
          {givenUp && waiting ? (
            <p className="rounded-lg border border-border p-3 text-sm leading-5">
              This is taking longer than usual. Your payment is still being checked in
              the background — if it went through, it will appear on your invoice
              shortly. Please do not pay again.
            </p>
          ) : null}

          {error ? (
            <p className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm font-semibold text-destructive">
              {error}
            </p>
          ) : null}

          <Link
            className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-semibold transition hover:bg-muted"
            href="/resident/payments"
          >
            <ArrowLeft aria-hidden="true" className="size-4" />
            Back to my payments
          </Link>
        </div>
      </SectionCard>
    </div>
  );
});
