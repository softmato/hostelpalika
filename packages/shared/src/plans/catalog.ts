/**
 * The plans-and-pricing arithmetic, shared by the website and the app.
 *
 * The catalogue itself is the `plans` section of the site config — authored in
 * Platform → Website Config → Plans & Pricing and served to both clients by
 * `/public/site-config`. What lives here is everything that *reads* it: what a
 * cycle costs, what it saves, which plan carries which service, and how a cap
 * is worded on a card.
 *
 * It is in `packages/shared` for the same reason the Bikram Sambat calendar is
 * next door: a price the website quotes and a price the app quotes have to be
 * the same price, and the way that stops being true is somebody maintaining two
 * implementations of the discount. The web imports it through the workspace
 * package; the app aliases the directory in Metro (`@hostel/plans/*`) because it
 * sits outside the npm workspace.
 *
 * **This file imports nothing.** Not zod, not a date library, not a logger — it
 * is bundled into a phone, and the moment it grows a dependency the alias above
 * has to grow one too. The types below are declared structurally so the
 * server's zod-inferred `PlansConfig` satisfies them without either side
 * importing the other.
 */

/** The metal a paid plan's directory badge is struck in. */
export type PlanTone = "gold" | "platinum";

export type PlanListingTierLike = {
  label: string;
  note: string;
  slug: string;
  tone: PlanTone;
};

export type PlanTierLike = {
  /** Percent off twelve months bought one month at a time. */
  annualDiscountPercent: number;
  ctaHref: string;
  ctaLabel: string;
  description: string;
  /** Percent off `monthly` while an event runs. Ignored outside one. */
  eventDiscountPercent: number;
  featured: boolean;
  /** Months free from the day a hostel goes live. Once per building. */
  freeMonths: number;
  /** Percent off six months bought one month at a time. */
  halfYearlyDiscountPercent: number;
  id: string;
  listingTier: PlanListingTierLike | null;
  /**
   * The price before an event rewrote `monthly` — stamped by `sellingCatalog`,
   * never authored and never stored. Absent means the plan is at list price.
   */
  listMonthly?: number;
  /** Branches a hostel on this plan may add. 0 means none. */
  maxBranches: number;
  /** `null` means no ceiling, which is not the same fact as a cap of zero. */
  maxResidents: number | null;
  /** Rupees per month when billed monthly. Every other figure derives from it. */
  monthly: number;
  name: string;
  portalAccess: { cooks: number | null; wardens: number | null };
};

export type PlanModuleLike = {
  description: string;
  icon: string;
  id: string;
  name: string;
};

export type PlanServiceLike = {
  audience: string[];
  blurb: string;
  demo: { mobileAssetId: string; webAssetId: string };
  how: string[];
  module: string;
  name: string;
  /** The lowest plan that carries it. Every plan above carries it too. */
  plan: string;
  slug: string;
  what: string[];
  why: string[];
};

/**
 * ## The event switch
 *
 * The catalogue runs in one of two modes. `standard` is the ordinary flow —
 * three prices, two cycle discounts, nothing else. `event` is a dated sale: it
 * takes `eventDiscountPercent` off each plan's monthly price until the end of
 * the BS month named in `endsOn`, and every figure derived from `monthly` — the
 * six-month total, the annual total, the saving pill, the price a hostel is
 * actually invoiced — follows it, because they were all already derived from
 * `monthly` and nothing else.
 *
 * `endsOn` is a BS period key (`"2083-06"`), inclusive, so the comparison is a
 * string compare against the current period rather than timezone arithmetic —
 * which is also why this file still imports nothing.
 */
export type PlanEventLike = {
  /** BS period key, inclusive. The event stops at the end of this month. */
  endsOn: string;
  /** What the badge on the cards calls it. */
  label: string;
  mode: "standard" | "event";
  /** One line under the badge. Blank shows nothing. */
  note: string;
};

/**
 * Only the parts the arithmetic reads. The stored section carries a `page`
 * block as well — headings and the closing pitch — which nothing here needs, so
 * asking for it would be asking a caller for something to be ignored.
 */
export type PlansCatalog = {
  cycleLabels: { annual: string; halfYearly: string; monthly: string };
  event: PlanEventLike;
  modules: PlanModuleLike[];
  plans: PlanTierLike[];
  services: PlanServiceLike[];
};

export type BillingCycle = "monthly" | "halfYearly" | "annual";

/** Longest commitment last, which is also cheapest per month. Toggle order. */
export function billingCycles(catalog: PlansCatalog) {
  return [
    { id: "monthly" as const, label: catalog.cycleLabels.monthly },
    { id: "halfYearly" as const, label: catalog.cycleLabels.halfYearly },
    { id: "annual" as const, label: catalog.cycleLabels.annual },
  ];
}

/** Months bought by one payment on this cycle. */
export function cycleMonths(cycle: BillingCycle) {
  return cycle === "annual" ? 12 : cycle === "halfYearly" ? 6 : 1;
}

/** The percent off this cycle carries, as the owner typed it. */
export function discountPercent(plan: PlanTierLike, cycle: BillingCycle) {
  if (cycle === "annual") {
    return plan.annualDiscountPercent;
  }

  return cycle === "halfYearly" ? plan.halfYearlyDiscountPercent : 0;
}

/**
 * What one payment on this cycle costs.
 *
 * Derived from the monthly price and the cycle's discount rather than stored
 * beside them: an owner who edits one figure would otherwise leave two others
 * saying something different, and the "Save 17%" badge on the toggle is read
 * straight off the same number. Rounded to the whole rupee — nobody quotes
 * paisa for a subscription.
 */
export function cycleTotal(plan: PlanTierLike, cycle: BillingCycle) {
  const months = cycleMonths(cycle);

  return Math.round(plan.monthly * months * (1 - discountPercent(plan, cycle) / 100));
}

/**
 * What `months` months cost, for any count from 1 to 12.
 *
 * Priced at the best cycle the count reaches: 1–5 at the monthly price, 6–11
 * at the six-month offer's own rate a month, 12 at the annual price. So seven
 * months is the six-month rate times seven — a longer stay never costs more a
 * month than a shorter one.
 */
export function monthsTotal(plan: PlanTierLike, months: number) {
  if (months >= 12) return Math.round((cycleTotal(plan, "annual") / 12) * months);
  if (months >= 6) return Math.round((cycleTotal(plan, "halfYearly") / 6) * months);

  return cycleTotal(plan, "monthly") * months;
}

/** The cycle whose rate `monthsTotal` charges for this many months. */
export function cycleForMonths(months: number): BillingCycle {
  return months >= 12 ? "annual" : months >= 6 ? "halfYearly" : "monthly";
}

/** `Monthly`, `6 months`, `Annual` for the three cycles; `7 months` for anything else. */
export function monthsLabel(catalog: Pick<PlansCatalog, "cycleLabels">, months: number) {
  if (months === 1) return catalog.cycleLabels.monthly;
  if (months === 6) return catalog.cycleLabels.halfYearly;
  if (months === 12) return catalog.cycleLabels.annual;

  return `${months} months`;
}

/**
 * Rupees a month on the chosen cycle — every price on the cards is shown per
 * month, so three cycles are compared on one number rather than on three
 * numbers over three different spans.
 */
export function monthlyRateFor(plan: PlanTierLike, cycle: BillingCycle) {
  return Math.round(cycleTotal(plan, cycle) / cycleMonths(cycle));
}

/**
 * The plan's list price a month — what it costs outside an event.
 *
 * Every comparison a card draws is drawn against this, so an event and a cycle
 * discount stack into one honest "was / now" instead of two.
 */
export function listMonthly(plan: PlanTierLike) {
  return plan.listMonthly ?? plan.monthly;
}

/** Rupees kept by paying the span up front instead of month by month. */
export function savingFor(plan: PlanTierLike, cycle: BillingCycle) {
  return listMonthly(plan) * cycleMonths(cycle) - cycleTotal(plan, cycle);
}

/** True while the catalogue is in event mode and `period` is inside its window. */
export function eventRuns(catalog: PlansCatalog, period: string) {
  // Optional on purpose: a catalogue from before this field existed is standard
  // mode, not a crash in the middle of pricing somebody's plan.
  const { endsOn = "", mode = "standard" } = catalog.event ?? {};

  // Zero-padded `YYYY-MM` sorts as a date, so the window is a string compare.
  return mode === "event" && endsOn !== "" && period <= endsOn;
}

/** Percent off this plan's monthly price, once the event is known to be running. */
function eventPercent(plan: PlanTierLike) {
  return Math.min(90, Math.max(0, plan.eventDiscountPercent));
}

/**
 * One plan at its offer price — **the event discount instead of the cycle
 * discounts, never both.**
 *
 * The cycle discounts go to zero here on purpose. A plan already 60% off is not
 * also 17% off for paying a year up front; stacking them would quote a third
 * number nobody set, and a card advertising "60% off" beside "save 17%" is two
 * offers where the hostel was given one. During an event the event *is* the
 * discount, and the six-month and annual prices are simply the offer price
 * times six and twelve.
 *
 * A plan with no event discount is left alone — it is not in the sale, so it
 * keeps the cycle discounts it has always had.
 */
export function sellingPlan<Plan extends PlanTierLike>(plan: Plan): Plan {
  const percent = eventPercent(plan);

  if (percent <= 0) {
    return plan;
  }

  return {
    ...plan,
    annualDiscountPercent: 0,
    halfYearlyDiscountPercent: 0,
    listMonthly: plan.monthly,
    monthly: Math.round(plan.monthly * (1 - percent / 100)),
  };
}

/**
 * The catalogue as it is actually sold in `period`.
 *
 * A running event rewrites each plan through {@link sellingPlan} and keeps the
 * old monthly figure in `listMonthly`. Everything downstream — `cycleTotal`,
 * `monthlyRateFor`, `savingFor`, the price `pricePlan` invoices — already
 * derives from `monthly` and the cycle percentages, so rewriting those three
 * fields is the whole feature: nothing else learns that events exist. Outside
 * the window the same object comes back untouched, which is what keeps standard
 * mode the standard flow.
 *
 * It runs on the **server** — once in the public site-config projection and
 * once in `pricePlan` — so a phone with a wrong clock cannot extend a sale.
 */
export function sellingCatalog<Catalog extends PlansCatalog>(
  catalog: Catalog,
  period: string,
): Catalog {
  if (!eventRuns(catalog, period)) {
    return catalog;
  }

  return { ...catalog, plans: catalog.plans.map(sellingPlan) } as Catalog;
}


/** The best event discount on offer, for one badge the whole page can wear. */
export function bestEventPercent(catalog: PlansCatalog) {
  return Math.max(0, ...catalog.plans.map((plan) => (plan.listMonthly ? eventPercent(plan) : 0)));
}

/**
 * The single number the billing toggle can honestly advertise. Each plan
 * discounts by a different amount, so the badge quotes the best of them rather
 * than a figure two of the three cards would then contradict.
 */
export function bestDiscountPercent(catalog: PlansCatalog, cycle: BillingCycle) {
  return Math.max(0, ...catalog.plans.map((plan) => discountPercent(plan, cycle)));
}

/**
 * The same badge in rupees, for when a percentage is the wrong unit.
 *
 * During an event the cycle discounts are zero — the event is the discount —
 * so `bestDiscountPercent` above honestly reads 0 and "Save up to 0%" is all it
 * can say. The saving is real and large; it is just not a *cycle* saving. So
 * the toggle quotes the biggest one on offer as money instead.
 */
export function bestSaving(catalog: PlansCatalog, cycle: BillingCycle) {
  return Math.max(0, ...catalog.plans.map((plan) => savingFor(plan, cycle)));
}

/** Rupees, grouped the way a price is read rather than the way it is stored. */
export function formatPlanRate(rupees: number) {
  return `NPR ${rupees.toLocaleString("en-IN")}`;
}

export function getPlan(catalog: PlansCatalog, id: string) {
  return catalog.plans.find((plan) => plan.id === id);
}

export function getServiceModule(catalog: PlansCatalog, id: string) {
  return catalog.modules.find((module) => module.id === id);
}

export function getService(catalog: PlansCatalog, slug: string) {
  return catalog.services.find((service) => service.slug === slug);
}

/** Cheapest-first rank, so "is it in this plan" is a comparison, not a lookup. */
export function planRank(catalog: PlansCatalog, id: string) {
  return catalog.plans.findIndex((plan) => plan.id === id);
}

/** The plan one step cheaper, or `undefined` on the entry plan. */
export function planBelow(catalog: PlansCatalog, id: string) {
  const rank = planRank(catalog, id);

  return rank > 0 ? catalog.plans[rank - 1] : undefined;
}

/** A plan carries a service when the service's own tier is at or below it. */
export function planIncludes(
  catalog: PlansCatalog,
  planId: string,
  service: PlanServiceLike,
) {
  const serviceRank = planRank(catalog, service.plan);

  // A service pointing at a plan that no longer exists is carried by none of
  // them rather than by all of them — an unknown tier must not read as free.
  return serviceRank >= 0 && serviceRank <= planRank(catalog, planId);
}

/**
 * The services a plan is the first to carry, flat and in catalogue order.
 *
 * Flat is the whole point: a card is read down its ticks, and every heading
 * tried above it — module names, then four coarser buckets — turned one list
 * into a list of lists, which is read as neither. The modules still group these
 * services for the detail pages; a plan card does not need them to.
 */
export function newServicesForPlan(catalog: PlansCatalog, planId: string) {
  return catalog.services.filter((service) => service.plan === planId);
}

/**
 * Services a card must not print, because a line above the list already names
 * them. The cook seat line *is* "1 cook portal account" and the warden seat line
 * *is* "2 warden portal accounts" — printing "Cook Portal" or "Staff Accounts &
 * Roles" underneath them is the same fact twice, and each seat line already
 * carries the link to that page.
 */
const NAMED_BY_A_SEAT_LINE = ["cook-portal", "warden-roles"];

/** What a plan card lists: what it adds, minus what its seat lines already say. */
export function cardServicesForPlan(catalog: PlansCatalog, planId: string) {
  return newServicesForPlan(catalog, planId).filter(
    (service) => !NAMED_BY_A_SEAT_LINE.includes(service.slug),
  );
}

/**
 * One capped count, worded the way a card line is read.
 *
 * Every band is stated as a ceiling rather than as a range: a reader who knows
 * they house 70 gets their answer from one number per card, where "51–100"
 * makes them check a floor as well as a ceiling on all three. The top plan has
 * no ceiling, so it is phrased against the cap of the plan below it — hence
 * `capBelow`, which the caller reads off the same field one plan down.
 *
 * A cap of one takes the singular and drops "Up to": "1 cook portal account" is
 * the whole truth, and "Up to 1" reads as a limit being apologised for.
 */
function capLabel({
  cap,
  capBelow,
  plural,
  singular,
}: {
  cap: number | null;
  capBelow: number | null;
  plural: string;
  singular: string;
}) {
  if (cap === 1) {
    return `1 ${singular}`;
  }

  if (cap !== null) {
    return `Up to ${cap.toLocaleString("en-IN")} ${plural}`;
  }

  return capBelow === null
    ? `Unlimited ${plural}`
    : `More than ${capBelow.toLocaleString("en-IN")} ${plural}`;
}

/**
 * "Up to 50 residents", "Up to 100 residents", "More than 100 residents".
 *
 * The plan's headline capacity, and the one line a card leads with: it is what
 * the price is set by, so it stands on its own above the account counts rather
 * than being folded in among them.
 */
export function residentRangeLabel(catalog: PlansCatalog, plan: PlanTierLike) {
  return capLabel({
    cap: plan.maxResidents,
    capBelow: planBelow(catalog, plan.id)?.maxResidents ?? null,
    plural: "residents",
    singular: "resident",
  });
}

/**
 * Who at this hostel gets an account, and how many of each.
 *
 * The resident line is `maxResidents` said a second way rather than a number of
 * its own: a resident who lives here gets an account, so the plan's resident
 * cap *is* its resident account count, and a separate field for it would be two
 * numbers free to disagree — which is also why the capacity line above it, from
 * `residentRangeLabel`, can never contradict this one. Wardens and cooks are
 * staff accounts the hostel hands out, so they carry their own caps in
 * `portalAccess`.
 *
 * Each line names the service that explains that role's surface, so a count on
 * a card is answerable the same way every other line on it is — by opening it.
 * `slug` is `null` when the owner has removed that service from the catalogue,
 * which is the caller's cue to render a plain line rather than a link into a
 * page that no longer exists.
 */
export function portalAccessLines(catalog: PlansCatalog, plan: PlanTierLike) {
  const below = planBelow(catalog, plan.id);
  const linkTo = (slug: string) => (getService(catalog, slug) ? slug : null);

  return [
    {
      id: "resident" as const,
      label: capLabel({
        cap: plan.maxResidents,
        capBelow: below?.maxResidents ?? null,
        plural: "resident portal accounts",
        singular: "resident portal account",
      }),
      slug: linkTo("resident-directory"),
    },
    {
      id: "warden" as const,
      label: capLabel({
        cap: plan.portalAccess.wardens,
        capBelow: below?.portalAccess.wardens ?? null,
        plural: "warden portal accounts",
        singular: "warden portal account",
      }),
      slug: linkTo("warden-roles"),
    },
    {
      id: "cook" as const,
      label: capLabel({
        cap: plan.portalAccess.cooks,
        capBelow: below?.portalAccess.cooks ?? null,
        plural: "cook portal accounts",
        singular: "cook portal account",
      }),
      slug: linkTo("cook-portal"),
    },
  ];
}

/** Every module with its full service list, for a catalogue view. */
export function servicesByModule(catalog: PlansCatalog) {
  return catalog.modules.map((module) => ({
    module,
    services: catalog.services.filter((service) => service.module === module.id),
  }));
}

/**
 * Services pointing at a module that no longer exists. Nothing public renders
 * them, so the admin catalogue shows them under a heading of their own rather
 * than letting a service vanish from the one screen that can fix it.
 */
export function orphanedServices(catalog: PlansCatalog) {
  const known = catalog.modules.map((module) => module.id);

  return catalog.services.filter((service) => !known.includes(service.module));
}

/**
 * The badges, in plan order, each with the plan that carries it.
 *
 * Derived from the plans rather than listed again: a badge exists because a
 * plan grants it, so a second list would be a second place for the pair to
 * disagree.
 */
export function listingTiers(catalog: PlansCatalog) {
  const entries: { plan: PlanTierLike; tier: PlanListingTierLike }[] = [];

  for (const plan of catalog.plans) {
    if (plan.listingTier) {
      entries.push({ plan, tier: plan.listingTier });
    }
  }

  return entries;
}

export function getListingTier(catalog: PlansCatalog, slug: string) {
  return listingTiers(catalog).find((entry) => entry.tier.slug === slug);
}

/** `/plans-pricing/badge/<slug>`. Sibling of `serviceHref`, same contract. */
export function listingTierHref(slug: string) {
  return `/plans-pricing/badge/${slug}`;
}

/** `/plans-pricing/<slug>`. One place builds it, so links and sitemap agree. */
export function serviceHref(slug: string) {
  return `/plans-pricing/${slug}`;
}
