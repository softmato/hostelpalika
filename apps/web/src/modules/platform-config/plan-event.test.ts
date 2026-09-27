import { describe, expect, it } from "vitest";

import {
  cycleTotal,
  savingFor,
  sellingCatalog,
  type PlansCatalog,
} from "@hostel/shared/plans/catalog";

/**
 * The event switch, checked where it actually decides money: the same
 * `sellingCatalog` the public projection and `pricePlan` both run.
 *
 * What matters is that standard mode is untouched, that an expired event is
 * standard mode, and that a running one reaches the six-month and annual
 * totals — because those are what a hostel buys during a sale.
 */
function catalogWith(event: PlansCatalog["event"]): PlansCatalog {
  return {
    cycleLabels: { annual: "Annual", halfYearly: "6 months", monthly: "Monthly" },
    event,
    modules: [],
    plans: [
      {
        annualDiscountPercent: 10,
        ctaHref: "/register-hostel",
        ctaLabel: "Start",
        description: "",
        eventDiscountPercent: 60,
        featured: false,
        freeMonths: 0,
        halfYearlyDiscountPercent: 0,
        id: "go",
        listingTier: null,
        maxBranches: 0,
        maxResidents: 50,
        monthly: 3000,
        name: "Go",
        portalAccess: { cooks: 1, wardens: 1 },
      },
    ],
    services: [],
  };
}

const EVENT = { endsOn: "2083-06", label: "Festival offer", mode: "event" as const, note: "" };

describe("sellingCatalog", () => {
  it("leaves standard mode exactly as stored", () => {
    const catalog = catalogWith({ ...EVENT, mode: "standard" });

    expect(sellingCatalog(catalog, "2083-05")).toBe(catalog);
  });

  it("leaves the catalogue alone once the last month has passed", () => {
    const catalog = catalogWith(EVENT);

    expect(sellingCatalog(catalog, "2083-07")).toBe(catalog);
    // Inclusive: the offer runs through the whole month it names.
    expect(sellingCatalog(catalog, "2083-06").plans[0].monthly).toBe(1200);
  });

  it("is ignored while no end month is set", () => {
    const catalog = catalogWith({ ...EVENT, endsOn: "" });

    expect(sellingCatalog(catalog, "2083-05")).toBe(catalog);
  });

  it("discounts the monthly price and keeps the list price beside it", () => {
    const plan = sellingCatalog(catalogWith(EVENT), "2083-05").plans[0];

    expect(plan.monthly).toBe(1200);
    expect(plan.listMonthly).toBe(3000);
  });

  it("carries the offer into the six-month and annual totals", () => {
    const plan = sellingCatalog(catalogWith(EVENT), "2083-05").plans[0];

    // Six months and a year are the offer price times six and twelve. The
    // plan's own 10% annual discount does NOT stack on top of the 60%: one
    // event, one discount.
    expect(cycleTotal(plan, "halfYearly")).toBe(7200);
    expect(cycleTotal(plan, "annual")).toBe(14_400);
    expect(plan.annualDiscountPercent).toBe(0);
    expect(plan.halfYearlyDiscountPercent).toBe(0);
    expect(savingFor(plan, "annual")).toBe(3000 * 12 - 14_400);
  });

  it("leaves a plan that is not in the sale on its own cycle discounts", () => {
    const catalog = catalogWith(EVENT);

    catalog.plans[0].eventDiscountPercent = 0;

    const plan = sellingCatalog(catalog, "2083-05").plans[0];

    expect(plan.listMonthly).toBeUndefined();
    expect(plan.annualDiscountPercent).toBe(10);
    expect(cycleTotal(plan, "annual")).toBe(32_400);
  });
});
