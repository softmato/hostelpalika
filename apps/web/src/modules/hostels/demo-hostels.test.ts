import { describe, expect, it } from "vitest";

import { demoHostels, demoHostelsMatching, findDemoHostel, isDemoHostelId } from "./demo-hostels";

describe("demo hostels", () => {
  it("are published, verified samples with unique slugs", () => {
    expect(demoHostels).toHaveLength(22);
    expect(new Set(demoHostels.map((hostel) => hostel.slug)).size).toBe(22);
    expect(demoHostels.every((hostel) => hostel.isDemoData && hostel.status === "PUBLISHED")).toBe(true);
  });

  it("fill every home-page area card (/hostels?area=…)", () => {
    for (const area of ["Thamel", "Boudha", "Lazimpat", "New Baneshwor"]) {
      expect(demoHostelsMatching({ area }).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("narrow the way the Mongo filter does", () => {
    expect(demoHostelsMatching({})).toHaveLength(22);
    expect(demoHostelsMatching({ city: "pokhara" }).every((h) => h.location.city === "Pokhara")).toBe(true);
    expect(demoHostelsMatching({ type: "GIRLS" }).every((h) => h.hostelType === "GIRLS")).toBe(true);
    expect(demoHostelsMatching({ area: "baneshwor" }).map((h) => h.slug)).toEqual([
      "saathi-ghar-boys-hostel-new-baneshwor",
      "thapagaun-co-living-new-baneshwor",
    ]);

    const short = demoHostelsMatching({ stay: "short" });
    expect(short.length).toBeGreaterThan(0);
    expect(short.every((h) => h.shortStays.enabled)).toBe(true);

    for (const hostel of demoHostelsMatching({ maxPrice: 8000 })) {
      expect(hostel.pricing.monthlyRentMin).toBeLessThanOrEqual(8000);
    }
  });

  it("are found by slug or id, and nothing else is", () => {
    const [first] = demoHostels;

    expect(findDemoHostel(first.slug)).toBe(first);
    expect(findDemoHostel(first._id.toString())).toBe(first);
    expect(isDemoHostelId(first._id.toString())).toBe(true);
    expect(findDemoHostel("some-real-hostel")).toBeUndefined();
  });
});
