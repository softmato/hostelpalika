"use client";

import { ArrowLeft, ArrowUpRight } from "@/components/icons";
import Link from "next/link";

import { cn } from "@/lib/utils";

import { TIER_TONE } from "./listing-tier-tone";
import { PlanMark } from "./plan-mark";
import {
  getService,
  listingTierHref,
  listingTiers,
  planRank,
  residentRangeLabel,
  serviceHref,
  type Plan,
  type PlansConfig,
} from "./plans-catalog";
import { PublicShell } from "./shared";
import { StarsCtaCard } from "./stars-cta-card";

/**
 * One directory badge, explained.
 *
 * Its own page rather than a line pointing at the public listing: the listing is
 * a hostel's own page, and the badge is what a plan buys in front of it, so a
 * reader who clicks "Platinum hostel badge" wanting to know what it means was
 * being handed the answer to a different question.
 *
 * What is written here is only what the catalogue already asserts — the plan
 * grants the badge, the badge sets the rank, and no listing is ranked by hand.
 * Anything further about how the directory orders listings belongs in the
 * ranking code first and on this page second.
 */
export function PublicListingBadgePage({
  catalog,
  plan,
  tier,
}: {
  catalog: PlansConfig;
  plan: Plan;
  tier: NonNullable<Plan["listingTier"]>;
}) {
  const tone = TIER_TONE[tier.tone];
  const others = listingTiers(catalog).filter((entry) => entry.tier.slug !== tier.slug);
  // The listing is a service like any other, and an owner may have renamed or
  // removed it — so the link exists only while the page it points at does.
  const listingService = getService(catalog, "public-listing");

  return (
    <PublicShell active="plans-pricing">
      <div className="mx-auto max-w-[980px] px-5 pb-24 pt-10 md:px-8">
        <Link
          className="inline-flex items-center gap-1.5 text-sm font-medium text-muted-foreground transition hover:text-brand-teal"
          href="/plans-pricing"
        >
          <ArrowLeft className="size-4" />
          Plans &amp; Pricing
        </Link>

        <header className="mt-6">
          <span
            className={cn(
              "inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold",
              tone.badge,
            )}
          >
            {tier.label}
          </span>

          <h1 className="mt-4 font-heading text-3xl font-bold tracking-tight text-foreground md:text-4xl">
            {tier.label} badge
          </h1>
          <p className="mt-3 max-w-2xl text-base text-muted-foreground">{tier.note}</p>

          <dl className="mt-6 flex flex-wrap items-center gap-x-8 gap-y-3 border-y border-border py-4 text-sm">
            <div className="flex items-center gap-2">
              <dt className="text-muted-foreground">Carried by</dt>
              <dd className="font-semibold text-foreground">{plan.name}</dd>
            </div>
            <div className="flex items-center gap-2">
              <dt className="text-muted-foreground">Plan size</dt>
              <dd className="font-semibold text-foreground">
                {residentRangeLabel(catalog, plan)}
              </dd>
            </div>
          </dl>
        </header>

        <section className={cn("mt-10 rounded-2xl border p-6 md:p-8", tone.ring)}>
          <h2 className="font-heading text-lg font-bold text-foreground">
            How a hostel gets it
          </h2>
          <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            It comes with the plan. A hostel on{" "}
            <span className="font-semibold text-foreground">{plan.name}</span> wears the{" "}
            <span className={cn("font-semibold", tone.label)}>{tier.label}</span> badge
            from the day the plan starts, and loses it when the plan ends. There is
            nothing to apply for and no listing is promoted by hand — the plan sets the
            badge, and the badge sets the position.
          </p>
        </section>

        <div className="mt-10 grid gap-5 md:grid-cols-2">
          <article className="rounded-2xl border border-border bg-surface p-6">
            <h2 className="font-heading text-base font-bold text-foreground">
              Where it shows
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              On the hostel&apos;s card everywhere visitors browse — search, the map and
              Compare. Badged listings sit above unbadged ones in all three.
            </p>
            {listingService ? (
              <Link
                className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-brand-teal transition hover:brightness-110"
                href={serviceHref(listingService.slug)}
              >
                The listing itself
                <ArrowUpRight className="size-4" />
              </Link>
            ) : null}
          </article>

          <article className="rounded-2xl border border-border bg-surface p-6">
            <h2 className="font-heading text-base font-bold text-foreground">
              What it does not do
            </h2>
            <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
              It does not change what the listing says. Rent, rooms, facilities and
              reviews stay the hostel&apos;s own — the badge decides only where that
              listing is met.
            </p>
          </article>
        </div>

        {others.length > 0 ? (
          <section className="mt-12">
            <h2 className="font-heading text-lg font-bold text-foreground">
              {others.length === 1 ? "The other badge" : "The other badges"}
            </h2>
            <ul className="mt-4 grid gap-3 sm:grid-cols-2">
              {others.map(({ plan: otherPlan, tier: other }) => (
                <li key={other.slug}>
                  <Link
                    className="group flex h-full items-start gap-3 rounded-xl border border-border bg-surface p-4 transition hover:border-brand-teal/50 hover:shadow-sm"
                    href={listingTierHref(other.slug)}
                  >
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-teal/10 text-brand-teal">
                      <PlanMark rank={planRank(catalog, otherPlan.id)} />
                    </span>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 text-sm font-semibold text-foreground transition group-hover:text-brand-teal">
                        {other.label}
                        <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition group-hover:text-brand-teal" />
                      </span>
                      <span className="mt-1 block text-xs leading-relaxed text-muted-foreground">
                        Carried by {otherPlan.name}.
                      </span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <StarsCtaCard
          className="mt-16"
          contentClassName="flex flex-col items-center gap-5 p-8 text-center md:flex-row md:justify-between md:text-left"
        >
          <p className="text-sm text-emerald-50/85">
            The badge comes with {plan.name}, along with everything else on the plan.
          </p>
          <Link
            className="inline-flex shrink-0 items-center rounded-xl bg-white px-6 py-3 text-sm font-semibold text-brand-teal shadow-sm transition hover:bg-emerald-50"
            href={{ pathname: plan.ctaHref, query: { plan: plan.id } }}
          >
            {plan.ctaLabel}
          </Link>
        </StarsCtaCard>
      </div>
    </PublicShell>
  );
}
