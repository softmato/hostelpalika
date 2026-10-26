import { describe, expect, it } from "vitest";

import { DEFAULT_PLANS } from "@/modules/platform-config/plans.defaults";

import { compareListingTier, listingTiersByPlan } from "./listing-tier";

describe("listingTiersByPlan", () => {
  it("maps the shipped plans to their badges, higher plan ranked higher", () => {
    const tiers = listingTiersByPlan(DEFAULT_PLANS);

    expect(tiers.has("go")).toBe(false);
    expect(tiers.get("pro")).toMatchObject({ label: "Platinum hostel", tone: "platinum" });
    expect(tiers.get("max")).toMatchObject({ label: "Gold hostel", tone: "gold" });
    expect(tiers.get("max")!.rank).toBeGreaterThan(tiers.get("pro")!.rank);
  });

  it("follows the catalogue when a plan loses its badge", () => {
    const catalog = {
      plans: DEFAULT_PLANS.plans.map((plan) =>
        plan.id === "pro" ? { ...plan, listingTier: null } : plan,
      ),
    };

    expect(listingTiersByPlan(catalog).has("pro")).toBe(false);
  });
});

describe("compareListingTier", () => {
  const tiers = listingTiersByPlan(DEFAULT_PLANS);
  const gold = { listingTier: tiers.get("max")!, name: "gold" };
  const platinum = { listingTier: tiers.get("pro")!, name: "platinum" };
  const plain = { listingTier: null, name: "plain" };
  const plainToo = { listingTier: undefined, name: "plain too" };

  it("puts Gold, then Platinum, then unbadged hostels in their original order", () => {
    const rows: Array<{ listingTier?: (typeof gold)["listingTier"] | null; name: string }> = [
      plain,
      platinum,
      plainToo,
      gold,
    ];
    const sorted = rows.sort(compareListingTier);

    expect(sorted.map((row) => row.name)).toEqual(["gold", "platinum", "plain", "plain too"]);
  });

  it("only breaks ties when chained after another key", () => {
    const rows = [
      { listingTier: tiers.get("max")!, price: 9000 },
      { listingTier: null, price: 7000 },
      { listingTier: tiers.get("pro")!, price: 7000 },
    ];

    const sorted = [...rows].sort((a, b) => a.price - b.price || compareListingTier(a, b));

    expect(sorted.map((row) => row.price)).toEqual([7000, 7000, 9000]);
    expect(sorted[0].listingTier?.tone).toBe("platinum");
  });
});
