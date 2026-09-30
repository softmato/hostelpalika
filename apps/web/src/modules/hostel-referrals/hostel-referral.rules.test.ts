import { describe, expect, it } from "vitest";

import {
  commissionFor,
  describeBonus,
  extendByBonus,
  hostelCodeCandidates,
  normalizeHostelReferralCode,
} from "@/modules/hostel-referrals/hostel-referral.rules";
import { bsMonthsEnd } from "@hostel/shared/calendar/bs";

describe("hostel referral rules", () => {
  const end = bsMonthsEnd(new Date("2026-09-30T06:00:00Z"), 3);

  it("adds whole BS months the way a paid cycle would", () => {
    expect(extendByBonus(end, { days: 0, months: 1 })).toEqual(
      bsMonthsEnd(new Date(end.getTime() + 1), 1),
    );
  });

  it("adds days after months and leaves a zero bonus alone", () => {
    const months = extendByBonus(end, { days: 0, months: 2 });

    expect(extendByBonus(end, { days: 10, months: 2 }).getTime() - months.getTime()).toBe(
      10 * 24 * 60 * 60 * 1000,
    );
    expect(extendByBonus(end, { days: 0, months: 0 })).toEqual(end);
  });

  it("works out commission as an amount or a percent of the cycle price", () => {
    expect(commissionFor({ type: "AMOUNT", value: 500 }, 9999)).toBe(500);
    expect(commissionFor({ type: "PERCENT", value: 10 }, 1699)).toBe(170);
    expect(commissionFor({ type: "PERCENT", value: 10 }, null)).toBe(0);
  });

  it("describes a bonus in plain words", () => {
    expect(describeBonus({ days: 10, months: 1 })).toBe("1 month and 10 days");
    expect(describeBonus({ days: 15, months: 0 })).toBe("15 days");
    expect(describeBonus({ days: 0, months: 0 })).toBe("");
  });

  it("builds hostel codes from the name and the id tail", () => {
    const [first, second] = hostelCodeCandidates("Education Light Hostel", "66f1a2b3c4d5e6f7a8b9c0d1");

    expect(first).toBe("EDUC9C0D1");
    expect(second.startsWith("EDUC")).toBe(true);
    expect(second.length).toBeGreaterThan(first.length);
    expect(normalizeHostelReferralCode(" educ-9c0d1 ")).toBe("EDUC9C0D1");
  });
});
