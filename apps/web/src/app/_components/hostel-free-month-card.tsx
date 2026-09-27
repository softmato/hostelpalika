"use client";

import { Gift } from "lucide-react";
import Link from "next/link";

import { useSiteConfig } from "@/components/site-config-provider";
import { useWorkspaceHref } from "@/hooks/use-workspace-href";
import { usePortalResource } from "@/lib/portal-query";
import { formatBsDate } from "@hostel/shared/calendar/bs";

type State = {
  subscription: {
    freeMonthNow: { endsAt: string; left: number; month: number; of: number } | null;
    freeUntil: string | null;
    planName: string | null;
  };
} | null;

/**
 * "Enjoy the free Go plan this month" — shown while a hostel is on its free
 * months, on the dashboard and on Billing.
 *
 * It renders nothing outside them. The website may say where the plan is
 * recharged afterwards; the app says only the facts (Play payments rule), so
 * this line has no twin there.
 */
export function HostelFreeMonthCard({ showBillingLink = true }: { showBillingLink?: boolean }) {
  const { identity } = useSiteConfig();
  const workspaceHref = useWorkspaceHref();
  const resource = usePortalResource<{ state: State }>("/api/v1/hostel-admin/subscription");
  const subscription = resource.data?.state?.subscription;
  const now = subscription?.freeMonthNow;

  if (!subscription || !now) {
    return null;
  }

  const plan = subscription.planName ? `${subscription.planName} plan` : "plan";
  const until = formatBsDate(new Date(subscription.freeUntil ?? now.endsAt));

  return (
    <section className="flex flex-wrap items-start gap-3 rounded-lg border border-brand-teal/30 bg-brand-teal/5 p-4 text-sm">
      <Gift aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-brand-teal" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-semibold text-foreground">
          Welcome — enjoy the free {plan} this month
          {now.left > 0
            ? `, and ${now.left} more free ${now.left === 1 ? "month" : "months"} after it.`
            : ". This is your last free month."}
        </p>
        <p className="text-muted-foreground">
          Free month {now.month} of {now.of}, until {until}. No payment is needed until then.
          After that, recharge this hostel from Billing
          {identity.supportPhone ? `, or call us on ${identity.supportPhone}` : ""}.
        </p>
      </div>
      {showBillingLink ? (
        <Link
          className="shrink-0 self-center text-xs font-semibold text-brand-teal underline"
          href={workspaceHref("/hostel-admin/billing")}
        >
          Billing
        </Link>
      ) : null}
    </section>
  );
}
