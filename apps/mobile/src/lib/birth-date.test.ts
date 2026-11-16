import { describe, expect, it } from "vitest";

import { adToBs, bsToAd, daysIn } from "@/lib/birth-date";

describe("birth date AD ⇄ BS", () => {
  it("converts both ways and back", () => {
    const bs = adToBs("2001-07-27");
    expect(bs).toMatch(/^2058-04-\d{2}$/);
    expect(bsToAd(bs!)).toBe("2001-07-27");
    expect(adToBs(bsToAd("2060-01-01")!)).toBe("2060-01-01");
  });

  it("refuses what is not a day", () => {
    expect(bsToAd("2060-13-01")).toBeNull();
    expect(bsToAd("2060-01-40")).toBeNull();
    expect(adToBs("27/07/2001")).toBeNull();
  });

  it("knows month lengths", () => {
    expect(daysIn("AD", 2000, 2)).toBe(29);
    expect(daysIn("BS", 2060, 1)).toBeGreaterThanOrEqual(29);
  });
});
