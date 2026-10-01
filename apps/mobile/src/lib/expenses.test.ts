import { describe, expect, it } from "vitest";

import {
  type ExpenseRow,
  bsDayLong,
  groupDigits,
  groupExpensesByDay,
  isFutureDay,
  monthChange,
  parseAmountInput,
  parseBsDayInput,
  recentDayChoices,
  relativeBsDay,
  toBsDayInput,
  todayKey,
} from "@/lib/expenses";

// 1 October 2026, mid-morning in Kathmandu — 15 Asoj 2083.
const NOW = new Date("2026-10-01T04:00:00Z");

function row(overrides: Partial<ExpenseRow>): ExpenseRow {
  return {
    amount: 100,
    category: "GROCERIES",
    categoryLabel: "Groceries",
    createdAt: null,
    customCategoryId: null,
    id: Math.random().toString(36),
    mine: true,
    paidBy: "CASH",
    payer: "HOSTEL",
    photoAssetId: null,
    recordedBy: { id: "u1", name: "Owner", role: "HOSTEL_ADMIN" },
    salaryFor: null,
    spentOn: "2026-10-01",
    status: "RECORDED",
    voidReason: null,
    voidedAt: null,
    what: "",
    ...overrides,
  };
}

describe("Nepali days", () => {
  it("starts on today in Nepal, not today in UTC", () => {
    expect(todayKey(NOW)).toBe("2026-10-01");
    // 19:00 UTC is already the 2nd in Kathmandu.
    expect(todayKey(new Date("2026-10-01T19:00:00Z"))).toBe("2026-10-02");
  });

  it("offers this week as chips, today first, in BS", () => {
    const choices = recentDayChoices(NOW);

    expect(choices).toHaveLength(7);
    expect(choices[0]).toMatchObject({ key: "2026-10-01", label: "Today" });
    expect(choices[1]).toMatchObject({ key: "2026-09-30", label: "Yesterday" });
    expect(choices[0]?.sub).toBe(bsDayLong("2026-10-01").replace(/, \d{4}$/, ""));
  });

  it("reads a typed BS date back to the same day", () => {
    const typed = toBsDayInput("2026-10-01");

    expect(typed).toMatch(/^2083-06-\d{2}$/);
    expect(parseBsDayInput(typed)).toBe("2026-10-01");
    expect(parseBsDayInput(typed.replace(/-/g, "/"))).toBe("2026-10-01");
  });

  it("refuses a BS day that does not exist rather than rolling it over", () => {
    expect(parseBsDayInput("2083-06-33")).toBeNull();
    expect(parseBsDayInput("2083-13-01")).toBeNull();
    expect(parseBsDayInput("15 Asoj")).toBeNull();
  });

  it("knows a day that has not happened yet", () => {
    expect(isFutureDay("2026-10-02", NOW)).toBe(true);
    expect(isFutureDay("2026-10-01", NOW)).toBe(false);
  });

  it("says Today and Yesterday the way a person would", () => {
    expect(relativeBsDay("2026-10-01", NOW)).toBe("Today");
    expect(relativeBsDay("2026-09-30", NOW)).toBe("Yesterday");
    expect(relativeBsDay("2026-09-20", NOW)).toMatch(/2083$/);
  });
});

describe("amounts", () => {
  it("forgives commas, spaces and a currency prefix", () => {
    expect(parseAmountInput("2,400")).toBe(2400);
    expect(parseAmountInput(" 12 000 ")).toBe(12000);
    expect(parseAmountInput("Rs 500")).toBe(500);
  });

  it("refuses paisa rather than rounding them", () => {
    expect(parseAmountInput("2400.50")).toBeNull();
  });

  it("refuses nothing, zero and words", () => {
    expect(parseAmountInput("")).toBeNull();
    expect(parseAmountInput("0")).toBeNull();
    expect(parseAmountInput("two hundred")).toBeNull();
  });

  it("groups digits as they are typed", () => {
    expect(groupDigits("2400")).toBe("2,400");
    expect(groupDigits("1234567")).toBe("1,234,567");
    expect(groupDigits("00500")).toBe("500");
  });
});

describe("the list", () => {
  it("groups by day, newest first, and never counts a cancelled row", () => {
    const days = groupExpensesByDay(
      [
        row({ amount: 300, spentOn: "2026-09-30" }),
        row({ amount: 1000, spentOn: "2026-10-01" }),
        row({ amount: 500, spentOn: "2026-10-01", status: "VOID" }),
        row({ amount: 200, spentOn: "2026-10-01" }),
      ],
      NOW,
    );

    expect(days.map((day) => [day.label, day.total, day.rows.length])).toEqual([
      ["Today", 1200, 3],
      ["Yesterday", 300, 1],
    ]);
  });

  it("compares this month with the last only when there is a last", () => {
    expect(monthChange(5000, 0)).toBeNull();
    expect(monthChange(5000, 5000)).toBeNull();
    expect(monthChange(6000, 5000)).toEqual({ amount: 1000, more: true });
    expect(monthChange(4000, 5000)).toEqual({ amount: 1000, more: false });
  });
});
