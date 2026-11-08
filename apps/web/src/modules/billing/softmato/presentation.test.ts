import { describe, expect, it } from "vitest";

import { buildPresentation } from "@/modules/billing/softmato/presentation";
import type { PlansConfig } from "@/lib/platform-config/site-config.validation";

/**
 * The plan copy that reaches a customer on Softmato's checkout page and
 * invoice.
 *
 * Every string here comes from a catalogue a platform owner edits in a form,
 * and Softmato **rejects** a presentation block that quotes a price or breaks a
 * length rule. A rejected block does not degrade the invoice — it fails the
 * whole `createInvoice` call, and the owner cannot pay us.
 *
 * So what is pinned below is not formatting. It is that a marketing edit can
 * never take the payment flow down.
 */

const plan = (over: Partial<PlansConfig["plans"][number]> = {}) =>
  ({
    annualDiscountPercent: 0,
    ctaHref: "/register-hostel",
    ctaLabel: "Start",
    description: "A full house, or two floors of one.",
    featured: false,
    halfYearlyDiscountPercent: 0,
    id: "pro",
    listingTier: null,
    maxResidents: 100,
    monthly: 5_000,
    name: "Pro",
    portalAccess: { cooks: 3, wardens: 2 },
    ...over,
  }) as PlansConfig["plans"][number];

const build = (over: Partial<PlansConfig["plans"][number]> = {}) =>
  buildPresentation({
    cycleLabel: "Annual",
    cycleMonths: 12,
    plan: plan(over),
    planName: "Pro",
  });

describe("prices never reach the block", () => {
  /*
   * Each of these is a notation somebody will actually type into the plan
   * description field, and each is refused by the API. A dropped tagline is a
   * plainer invoice; a refused one is an owner who cannot give us money.
   */
  it.each([
    "NPR 5,000 a month",
    "Rs. 5000 per hostel",
    "Rs 5000",
    "5,000/- monthly",
    "₹5000 flat",
    "Just 5,000 all in",
    "3000 per month",
  ])("drops a tagline reading %j", (description) => {
    expect(build({ description })?.tagline).toBeUndefined();
  });

  it("keeps a bare number, which is not a price", () => {
    expect(build({ maxResidents: 500 })?.features).toContain("Up to 500 residents");
  });
});

describe("the other refusals", () => {
  it("drops copy promising a refund", () => {
    expect(build({ description: "Full refund within 30 days" })?.tagline).toBeUndefined();
  });

  it("drops copy speaking for Softmato", () => {
    expect(
      build({ description: "Softmato guarantees your payment" })?.tagline,
    ).toBeUndefined();
  });

  it("strips HTML rather than escaping it", () => {
    /*
     * Softmato escapes what it renders, so a surviving tag would arrive on the
     * invoice looking like a typo. Losing the emphasis is the better failure.
     */
    expect(build({ description: "A <b>full</b> house" })?.tagline).toBe("A full house");
  });
});

describe("the limits the API enforces", () => {
  it("never sends more than eight features", () => {
    const features = build({ listingTier: { label: "Gold", note: "n", slug: "g", tone: "gold" } })
      ?.features;

    expect(features?.length).toBeLessThanOrEqual(8);
  });

  it("cuts a long tagline at a word boundary and adds no ellipsis", () => {
    const tagline = build({ description: "house ".repeat(60).trim() })?.tagline ?? "";

    expect(tagline.length).toBeLessThanOrEqual(140);
    expect(tagline).not.toMatch(/[….]$/);
    expect(tagline).not.toMatch(/\s$/);
  });

  it("keeps the plan name inside eighty characters", () => {
    const name = buildPresentation({
      cycleLabel: "Annual",
      cycleMonths: 12,
      plan: plan(),
      planName: "P".repeat(120),
    })?.plan_name;

    expect((name ?? "").length).toBeLessThanOrEqual(80);
  });
});

describe("what is sent when there is nothing to say", () => {
  it("says unlimited out loud rather than omitting the line", () => {
    const features = build({
      maxResidents: null,
      portalAccess: { cooks: null, wardens: null },
    })?.features;

    expect(features).toContain("Unlimited residents");
    expect(features).toContain("Unlimited warden accounts");
  });

  it("still names the plan when the catalogue entry is gone", () => {
    /*
     * A superadmin may delete a tier after it was sold. The subscription's
     * snapshotted name outlives the catalogue, so the invoice keeps saying what
     * was bought.
     */
    const result = buildPresentation({
      cycleLabel: "Annual",
      cycleMonths: 12,
      plan: null,
      planName: "Pro",
    });

    expect(result?.plan_name).toBe("Pro — Annual");
    expect(result?.features).toBeUndefined();
  });

  it("sends no block at all when even the name fails its checks", () => {
    /*
     * `undefined`, not an empty object: omitted entirely, nothing renders and
     * Softmato invents no plan name on our behalf.
     */
    expect(
      buildPresentation({
        cycleLabel: "Annual",
        cycleMonths: 12,
        plan: plan(),
        planName: "Rs. 5000 tier",
      }),
    ).toBeUndefined();
  });
});
