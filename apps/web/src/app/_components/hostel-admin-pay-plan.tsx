"use client";

import { Clock } from "@/components/icons";

import { CheckoutHandoffButton } from "@/app/_components/checkout-handoff";
import { usePortalResource } from "@/lib/portal-query";
import type { PlanPaymentInstructions } from "@/modules/billing/subscription-claim.service";

/**
 * Paying the platform from the portal: one button that hands the owner to
 * Softmato checkout and brings them back to the return page.
 *
 * ## It renders nothing unless something is owed
 *
 * Most owners are paid up, and a payment panel on a settled account is an
 * invitation to pay twice. It appears when there is an outstanding balance.
 *
 * ## A proof already sent still gets its answer
 *
 * The QR-and-screenshot lane this replaced may have left a claim in review.
 * That owner is told it is being checked and is not offered a second way to
 * pay the same money.
 *
 * Nothing here can record a payment: Softmato confirms it, by a signed webhook
 * or by the server-side read the return page makes.
 */

const rupees = (value: number) => `NPR ${value.toLocaleString("en-IN")}`;

export function PayPlanPanel() {
  /*
   * The portal's own resource hook rather than a `useEffect` that fetches. It
   * is what every other panel in this portal uses, it caches and revalidates,
   * and it keeps a `setState` out of an effect body — which the React compiler
   * rejects outright as a cascading render.
   */
  const resource = usePortalResource<{ instructions: PlanPaymentInstructions }>(
    "/api/v1/hostel-admin/billing/pay-instructions",
  );

  const data = resource.data?.instructions ?? null;

  /*
   * Nothing owed, nothing loaded, nothing to say. Silent on failure too: this
   * panel is an addition to a page that already works, and an error card here
   * would be the loudest thing on a screen that is otherwise fine.
   */
  if (!data || !data.invoice || data.amountDue <= 0) {
    return null;
  }

  if (data.claim) {
    return (
      <section className="rounded-xl border border-warning/40 bg-warning/5 p-5">
        <div className="flex items-start gap-3">
          <Clock className="mt-0.5 size-5 shrink-0 text-warning" />
          <div className="space-y-1">
            <h2 className="text-sm font-bold text-foreground">
              We are checking your payment
            </h2>
            <p className="text-sm text-muted-foreground">
              You sent us proof of{" "}
              <strong className="text-foreground">
                {rupees(data.claim.amount)}
              </strong>
              . Our team verifies it within 1–2 working days and emails you
              either way. Your plan keeps working and your listing stays live in
              the meantime — there is nothing more to pay.
            </p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-wrap items-start justify-between gap-5 rounded-xl border border-border bg-card p-5">
      <div>
        <h2 className="text-sm font-bold text-foreground">Pay your plan</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {rupees(data.amountDue)} outstanding on {data.invoice.planName}
          {data.dueBy && data.overdue ? " — the deadline has passed." : "."}
        </p>
        {data.reference ? (
          <p className="mt-1 font-mono text-xs text-muted-foreground">Invoice {data.reference}</p>
        ) : null}
      </div>

      <CheckoutHandoffButton
        endpoint="/api/v1/hostel-admin/billing/checkout"
        label={`Pay ${rupees(data.amountDue)}`}
        preparing="Setting up your plan payment"
      />
    </section>
  );
}
