import { describe, expect, it } from "vitest";

import type { HostelSummary } from "@/app/_components/public-hostel-types";

import { homeFaq } from "./home-faq";

function hostel(overrides: Partial<HostelSummary>): HostelSummary {
  return {
    address: "",
    area: "Baneshwor",
    city: "Kathmandu",
    description: "",
    facilities: [],
    foodScore: 0,
    id: "x",
    image: "",
    name: "A",
    owner: "",
    price: 8000,
    rating: 0,
    reviews: 0,
    roomTypes: [],
    slug: "a",
    status: "published",
    type: "boys",
    vacancy: 0,
    verified: true,
    ...overrides,
  };
}

const badges = [
  { label: "Platinum hostel", plan: "Pro" },
  { label: "Gold hostel", plan: "Max" },
];

describe("homeFaq", () => {
  it("quotes Kathmandu rent from real listings only, never sample ones", () => {
    const faq = homeFaq({
      badges,
      cities: [{ count: 2, name: "Kathmandu" }],
      fromPrice: 999,
      hostels: [
        hostel({ price: 7500 }),
        hostel({ price: 12000 }),
        hostel({ isDemoData: true, price: 3000 }),
        hostel({ city: "Pokhara", price: 2000 }),
      ],
    });
    const cost = faq.find((entry) => entry.question.includes("cost in Kathmandu"));

    expect(cost?.answer).toContain("7,500");
    expect(cost?.answer).toContain("12,000");
    expect(cost?.answer).not.toContain("3,000");
  });

  it("leaves out questions it has no data to answer", () => {
    const faq = homeFaq({ badges: [], cities: [], fromPrice: 999, hostels: [] });
    const questions = faq.map((entry) => entry.question).join("\n");

    expect(questions).not.toContain("cost in Kathmandu");
    expect(questions).not.toContain("Which cities");
    expect(questions).not.toContain("badges mean");
  });

  it("names the badges and plans the catalogue actually has", () => {
    const faq = homeFaq({ badges, cities: [], fromPrice: 999, hostels: [] });
    const badge = faq.find((entry) => entry.question.includes("badges mean"));

    expect(badge?.question).toBe("What do the Platinum hostel and Gold hostel badges mean?");
    expect(badge?.answer).toContain("Gold hostel with the Max plan");
    expect(badge?.answer).toContain("not a rating");
  });
});
