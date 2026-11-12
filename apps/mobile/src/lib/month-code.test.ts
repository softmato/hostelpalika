import { describe, expect, it } from "vitest";

import { BS_MONTHS } from "../../../../packages/shared/src/calendar/bs";

import { MONTH_TAGS, nextMonthCode } from "./month-code";

describe("nextMonthCode", () => {
  it("uses the server's month tags", () => {
    expect([...MONTH_TAGS]).toEqual(BS_MONTHS.map((month) => month.slice(0, 3).toUpperCase()));
  });

  it("steps the month and rolls the year after Chaitra", () => {
    expect(nextMonthCode("RUP-482K-BHA83")).toBe("RUP-482K-ASW83");
    expect(nextMonthCode("rup-482k-cha83")).toBe("RUP-482K-BAI84");
    expect(nextMonthCode("RUP-4821-K")).toBeNull();
  });
});
