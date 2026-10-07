"use client";

import { Check, ChevronDown, Infinity as InfinityIcon, Sparkles } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import type { PublicSiteConfig } from "@/components/site-config-provider";
import { Skeleton } from "@/components/ui/skeleton";
import { browserApi } from "@/lib/browser-api";
import { fillPlaceholders } from "@/lib/site-content";
import { cn } from "@/lib/utils";
import type { LifetimeAvailability } from "@/modules/billing/lifetime";
import type { LifetimeConfig } from "@/modules/platform-config/site-config.validation";
import {
  formatLifetimeDay,
  lifetimeMonthsEquivalent,
  lifetimeOfferFor,
  lifetimeSeatsLeft,
  lifetimeTotalSeats,
  lifetimeWindow,
} from "@hostel/shared/plans/lifetime";

import { PlanMark } from "./plan-mark";
import {
  getPlan,
  planIncludes,
  planRank,
  portalAccessLines,
  residentRangeLabel,
  type PlansConfig,
} from "./plans-catalog";

/**
 * The lifetime deal: one payment for a tier, for life, to the first hostels
 * that take it.
 *
 * Its own block under the ordinary cards, not a fourth card among them and not
 * a fourth cycle on the toggle — the deal is a different kind of purchase (no
 * cycle, no free months, a fixed number of seats, an end date) and the tiers
 * above are left reading exactly as they always did. The `lifetime` site-config
 * section drives it; seats are counted live from `/api/v1/public/lifetime`.
 *
 * Shared by the public pricing page and the superadmin Lifetime tab's preview,
 * so the editor shows what a visitor gets.
 */

/** Seats sold and left, live. `null` while loading or when the read failed. */
export function useLifetimeAvailability(refreshKey = 0) {
  const [availability, setAvailability] = useState<LifetimeAvailability | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let live = true;

    void browserApi<{ lifetime: LifetimeAvailability }>("/api/v1/public/lifetime")
      .then((result) => {
        if (live) {
          setAvailability(result.lifetime);
          setFailed(false);
        }
      })
      .catch(() => {
        if (live) setFailed(true);
      });

    return () => {
      live = false;
    };
  }, [refreshKey]);

  return { availability, failed };
}

const money = (rupees: number) => `NPR ${rupees.toLocaleString("en-IN")}`;

export function LifetimeDeal({
  availability,
  catalog,
  deal,
  identity,
  preview = false,
}: {
  availability: LifetimeAvailability | null;
  catalog: PlansConfig;
  deal: LifetimeConfig;
  identity: PublicSiteConfig["identity"];
  /** The superadmin preview: drawn even when the deal is not on sale today. */
  preview?: boolean;
}) {
  const saleWindow = lifetimeWindow(deal);
  const offers = deal.offers.flatMap((offer) => {
    const plan = getPlan(catalog, offer.planId);

    return plan && lifetimeOfferFor(deal, offer.planId) ? [{ offer, plan }] : [];
  });

  if (offers.length === 0 || (!preview && saleWindow !== "open")) {
    return null;
  }

  const soldOf = (planId: string) =>
    availability?.offers.find((entry) => entry.planId === planId)?.sold ?? 0;
  const totalSeats = lifetimeTotalSeats(deal);
  const totalLeft = offers.reduce(
    (sum, { offer }) => sum + lifetimeSeatsLeft(offer, soldOf(offer.planId)),
    0,
  );
  const endsOn = formatLifetimeDay(deal.endsOn);

  return (
    <section
      aria-labelledby="lifetime-deal-title"
      className="mt-16 overflow-hidden rounded-3xl border border-brand-teal/30 bg-surface shadow-sm"
      id="lifetime"
    >
      {/* The painted header block, with the seat counter straddling its edge. */}
      <header className="relative rounded-b-3xl bg-brand-teal px-6 pb-10 pt-8 text-center text-white md:px-10">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1 text-[11px] font-bold uppercase tracking-wider">
          <Sparkles className="size-3.5" />
          {deal.badge || "Lifetime deal"}
        </span>
        <h2
          className="mt-3 font-heading text-3xl font-bold tracking-tight md:text-4xl"
          id="lifetime-deal-title"
        >
          {deal.title || "Pay once. Use it for life."}
        </h2>
        {deal.subtitle ? (
          <p className="mx-auto mt-2 max-w-2xl text-sm text-white/85 md:text-base">
            {fillPlaceholders(deal.subtitle, identity)}
          </p>
        ) : null}

        <div className="absolute -bottom-5 left-1/2 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full border border-border bg-surface px-4 py-2 text-xs font-semibold text-foreground shadow-sm">
          {availability ? (
            <>
              <span className="tabular-nums text-brand-teal">
                {totalLeft} of {totalSeats}
              </span>
              seats left
            </>
          ) : (
            <Skeleton className="h-4 w-28" />
          )}
          {endsOn ? <span className="text-muted-foreground">· ends {endsOn}</span> : null}
        </div>
      </header>

      {preview && saleWindow !== "open" ? (
        <p className="mx-6 mt-10 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-center text-xs font-semibold text-foreground">
          {saleWindow === "off"
            ? "Switched off — visitors do not see this section."
            : saleWindow === "upcoming"
              ? `Not on sale yet — visitors see it from ${formatLifetimeDay(deal.startsOn)}.`
              : `Ended — visitors stopped seeing it after ${endsOn}.`}
        </p>
      ) : null}

      <div
        className={cn(
          "grid gap-4 px-4 pb-6 sm:grid-cols-2 md:px-6 lg:grid-cols-3",
          preview && saleWindow !== "open" ? "pt-4" : "pt-12",
        )}
      >
        {offers.map(({ offer, plan }) => (
          <LifetimeCard
            catalog={catalog}
            ctaLabel={deal.ctaLabel || "Claim lifetime"}
            key={offer.planId}
            loading={!availability}
            offer={offer}
            open={saleWindow === "open"}
            plan={plan}
            preview={preview}
            sold={soldOf(offer.planId)}
          />
        ))}
      </div>

      {deal.note ? (
        <p className="px-6 pb-6 text-center text-xs text-muted-foreground">
          {fillPlaceholders(deal.note, identity)}
        </p>
      ) : null}
    </section>
  );
}

function LifetimeCard({
  catalog,
  ctaLabel,
  loading,
  offer,
  open,
  plan,
  preview,
  sold,
}: {
  catalog: PlansConfig;
  ctaLabel: string;
  loading: boolean;
  offer: LifetimeConfig["offers"][number];
  open: boolean;
  plan: PlansConfig["plans"][number];
  preview: boolean;
  sold: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const left = lifetimeSeatsLeft(offer, sold);
  const soldOut = !loading && left <= 0;
  const months = lifetimeMonthsEquivalent(offer.price, plan.monthly);
  // Everything the tier carries — not only what it adds over the one below.
  const features = catalog.services.filter((service) => planIncludes(catalog, plan.id, service));
  const capLines = [
    residentRangeLabel(catalog, plan),
    ...portalAccessLines(catalog, plan)
      .filter((line) => line.id !== "resident")
      .map((line) => line.label),
    ...(plan.listingTier ? [`${plan.listingTier.label} badge in the directory`] : []),
  ];
  const href = `/plans-pricing/checkout?plan=${encodeURIComponent(plan.id)}&lifetime=1`;
  const filled = offer.seats > 0 ? Math.min(100, (Math.min(sold, offer.seats) / offer.seats) * 100) : 100;

  return (
    <article className="flex flex-col rounded-2xl border border-border bg-background p-5 transition-colors hover:border-brand-teal/40">
      <div className="flex items-center gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-brand-teal/10 text-brand-teal">
          <PlanMark rank={planRank(catalog, plan.id)} />
        </span>
        <div className="min-w-0">
          <h3 className="font-heading text-xl font-bold leading-none text-foreground">
            {plan.name}
          </h3>
          <p className="mt-1 inline-flex items-center gap-1 text-[11px] font-bold uppercase tracking-wider text-brand-teal">
            <InfinityIcon className="size-3.5" />
            Lifetime
          </p>
        </div>
      </div>

      <p className="mt-4 font-heading text-3xl font-bold tracking-tight text-foreground">
        <span className="text-[0.6em] font-semibold text-muted-foreground">NPR</span>{" "}
        {offer.price.toLocaleString("en-IN")}
        <span className="ml-1.5 text-sm font-semibold text-muted-foreground">once</span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">
        {months ? `About ${months} months of ${plan.name} at ${money(plan.monthly)}/month — then nothing, ever.` : "Paid once — then nothing, ever."}
      </p>

      {/* Seats: the number a visitor acts on. */}
      <div className="mt-4">
        <div className="flex items-baseline justify-between text-xs">
          <span className="font-semibold text-foreground">
            {loading ? (
              <Skeleton className="inline-block h-3.5 w-24 align-middle" />
            ) : soldOut ? (
              "Sold out"
            ) : (
              `${left} of ${offer.seats} seats left`
            )}
          </span>
          {!loading && sold > 0 ? (
            <span className="text-muted-foreground">{sold} claimed</span>
          ) : null}
        </div>
        <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className={cn("h-full rounded-full", soldOut ? "bg-muted-foreground/40" : "bg-brand-teal")}
            style={{ width: loading ? "0%" : `${filled}%` }}
          />
        </div>
      </div>

      <p className="mt-4 text-sm font-semibold text-foreground">
        Every feature in {plan.name}, for life
      </p>
      <ul className="mt-2 space-y-1.5 text-sm text-muted-foreground">
        {capLines.map((line) => (
          <li className="flex gap-2" key={line}>
            <Check className="mt-0.5 size-4 shrink-0 text-brand-teal" />
            <span>{line}</span>
          </li>
        ))}
        <li className="flex gap-2">
          <Check className="mt-0.5 size-4 shrink-0 text-brand-teal" />
          <span>All {features.length} features of {plan.name}</span>
        </li>
      </ul>

      {features.length > 0 ? (
        <div className="mt-2">
          <button
            aria-expanded={showAll}
            className="inline-flex items-center gap-1 text-xs font-semibold text-brand-teal"
            onClick={() => setShowAll((value) => !value)}
            type="button"
          >
            {showAll ? "Hide the list" : `See all ${features.length} features`}
            <ChevronDown className={cn("size-3.5 transition", showAll && "rotate-180")} />
          </button>
          {showAll ? (
            <ul className="mt-2 grid gap-1 text-xs text-muted-foreground">
              {features.map((service) => (
                <li className="flex gap-1.5" key={service.slug}>
                  <Check className="mt-0.5 size-3 shrink-0 text-brand-teal" />
                  {service.name}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      <div className="mt-auto pt-5">
        {soldOut || (!open && !preview) ? (
          <span className="inline-flex w-full cursor-not-allowed items-center justify-center rounded-xl border border-border px-4 py-3 text-sm font-semibold text-muted-foreground">
            {soldOut ? "Sold out" : "Not on sale"}
          </span>
        ) : (
          <Link
            className="inline-flex w-full items-center justify-center rounded-xl bg-brand-teal px-4 py-3 text-sm font-semibold text-white shadow-sm transition hover:brightness-110"
            href={href}
          >
            {ctaLabel} · {money(offer.price)}
          </Link>
        )}
        <p className="mt-2 text-center text-[11px] text-muted-foreground">
          No free months · starts the day it is paid · no renewals
        </p>
      </div>
    </article>
  );
}
