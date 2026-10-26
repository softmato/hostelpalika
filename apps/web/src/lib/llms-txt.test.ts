import { describe, expect, it } from "vitest";

import { buildLlmsFullTxt, buildLlmsTxt, type LlmsData } from "./llms-txt";

const data: LlmsData = {
  base: "https://hostelpalika.com",
  cities: [
    {
      areas: [{ count: 1, name: "Baneshwor", slug: "baneshwor" }],
      count: 2,
      name: "Kathmandu",
      slug: "kathmandu",
      types: { BOYS: 1, CO_LIVING: 0, GIRLS: 1 },
    },
    { areas: [], count: 0, name: "Pokhara", slug: "pokhara", types: { BOYS: 0, CO_LIVING: 0, GIRLS: 0 } },
  ],
  comparisons: [{ name: "Excel", slug: "excel-spreadsheets", title: "HostelPalika vs Excel" }],
  features: [],
  hostels: [
    {
      area: "Baneshwor",
      city: "Kathmandu",
      listingTier: "Gold hostel",
      name: "Sunrise Boys Hostel",
      price: 9000,
      rating: 4.5,
      reviews: 2,
      slug: "sunrise-boys-hostel",
      type: "BOYS",
    },
    {
      area: "Koteshwor",
      city: "Kathmandu",
      listingTier: null,
      name: "Lotus Girls Hostel",
      price: 0,
      rating: 0,
      reviews: 0,
      slug: "lotus-girls-hostel",
      type: "GIRLS",
    },
  ],
  modules: [{ description: "Rooms and beds.", name: "Residents & Rooms" }],
  near: [{ city: "Lalitpur", count: 1, name: "Pulchowk Campus", slug: "pulchowk-campus" }],
  plans: [
    { badge: null, monthly: 999, name: "Go" },
    { badge: "Gold hostel", monthly: 2499, name: "Max" },
  ],
  software: { faq: [{ answer: "It is software.", question: "What is it?" }], sections: [] },
};

describe("buildLlmsTxt", () => {
  it("follows the llms.txt layout and links only cities that have hostels", () => {
    const text = buildLlmsTxt(data);

    expect(text.startsWith("# HostelPalika\n\n> ")).toBe(true);
    expect(text).toContain("(https://hostelpalika.com/hostels/in/kathmandu): 2 verified (1 boys, 1 girls)");
    expect(text).not.toContain("/hostels/in/pokhara");
    expect(text).toContain("https://hostelpalika.com/hostel-management-software");
    expect(text).toContain("https://hostelpalika.com/llms-full.txt");
  });
});

describe("buildLlmsFullTxt", () => {
  const text = buildLlmsFullTxt(data);

  it("states each hostel's public facts and nothing it does not have", () => {
    expect(text).toContain(
      "[Sunrise Boys Hostel](https://hostelpalika.com/hostels/sunrise-boys-hostel): boys hostel in Baneshwor, Kathmandu; rent from",
    );
    expect(text).toContain("rated 4.5/5 from 2 resident reviews; Gold hostel (paid placement)");
    expect(text).toContain("Lotus Girls Hostel](https://hostelpalika.com/hostels/lotus-girls-hostel): girls hostel in Koteshwor, Kathmandu; no reviews yet");
    expect(text).not.toMatch(/Lotus Girls Hostel.*rent from/);
  });

  it("explains badges as a paid placement and prints the plans and owner FAQ", () => {
    expect(text).toContain("paid placement, not a rating");
    expect(text).toContain("- Max:");
    expect(text).toContain("### What is it?");
    expect(text).toContain("/hostels/near/pulchowk-campus");
  });
});
