"use client";

import { Gift, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { useSiteConfig } from "@/components/site-config-provider";
import { useWorkspaceHref } from "@/hooks/use-workspace-href";
import { usePortalResource } from "@/lib/portal-query";
import { formatBsDate } from "@hostel/shared/calendar/bs";

type State = {
  subscription: {
    id: string;
    freeMonthNow: { endsAt: string; left: number; month: number; of: number } | null;
    freeUntil: string | null;
    planName: string | null;
  };
} | null;

/**
 * The welcome appears once per subscription in this browser. Billing keeps
 * the same card available throughout the free period.
 */
export function HostelFreeMonthCard({
  showBillingLink = true,
}: {
  showBillingLink?: boolean;
}) {
  const { identity } = useSiteConfig();
  const workspaceHref = useWorkspaceHref();
  const resource = usePortalResource<{ state: State }>(
    "/api/v1/hostel-admin/subscription",
  );
  const subscription = resource.data?.state?.subscription;
  const now = subscription?.freeMonthNow;
  const [welcomeKey, setWelcomeKey] = useState<string | null>(null);
  const storageKey = subscription?.id ? `hostel-free-welcome:${subscription.id}` : null;

  useEffect(() => {
    if (!showBillingLink || !now || !storageKey) return;
    const frame = window.requestAnimationFrame(() => {
      try {
        if (window.localStorage.getItem(storageKey) === "seen") return;
        window.localStorage.setItem(storageKey, "seen");
      } catch {
        // Private browsing may disable storage; the welcome can still be shown.
      }
      setWelcomeKey(storageKey);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [now, showBillingLink, storageKey]);

  if (!subscription || !now || (showBillingLink && welcomeKey !== storageKey)) {
    return null;
  }

  const plan = subscription.planName ? `${subscription.planName} plan` : "plan";
  const until = formatBsDate(new Date(subscription.freeUntil ?? now.endsAt));

  return (
    <section
      className={`free-plan-card relative isolate overflow-hidden rounded-xl border border-amber-300/60 p-4 text-sm shadow-sm dark:border-amber-500/30 sm:p-5 ${showBillingLink ? "free-plan-card-welcome" : ""}`}
    >
      <div className="relative z-10 flex flex-wrap items-start gap-3 sm:gap-4">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-amber-300/60 bg-white/70 text-amber-700 shadow-sm dark:border-amber-500/30 dark:bg-amber-950/40 dark:text-amber-300">
          <Gift aria-hidden="true" className="size-5" />
        </span>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="flex items-center gap-1.5 font-semibold text-foreground">
            <Sparkles
              aria-hidden="true"
              className="size-4 shrink-0 text-amber-600 dark:text-amber-300"
            />
            Welcome — enjoy the free {plan} this month
            {now.left > 0
              ? `, and ${now.left} more free ${now.left === 1 ? "month" : "months"} after it.`
              : ". This is your last free month."}
          </p>
          <p className="leading-relaxed text-muted-foreground">
            Free month {now.month} of {now.of}, until {until}. No payment is needed until
            then. After that, recharge this hostel from Billing
            {identity.supportPhone ? `, or call us on ${identity.supportPhone}` : ""}.
          </p>
        </div>
        {showBillingLink ? (
          <Link
            className="shrink-0 self-center rounded-lg border border-amber-400/50 bg-white/70 px-3 py-2 text-xs font-semibold text-amber-900 transition-colors hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600 dark:bg-amber-950/40 dark:text-amber-100 dark:hover:bg-amber-950/70"
            href={workspaceHref("/hostel-admin/billing")}
          >
            Billing
          </Link>
        ) : null}
      </div>
    </section>
  );
}
