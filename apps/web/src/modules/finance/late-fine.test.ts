import { describe, expect, it } from "vitest";

import { fineDueDate, lateFineLine, refineInvoice } from "@/modules/finance/late-fine.service";

const DAY = 24 * 60 * 60 * 1000;
// Calendar days are stored as UTC midnight; Nepal noon is 06:15 UTC.
const due = new Date("2026-09-17T00:00:00.000Z");
const nepalNoon = (daysAfterDue: number) => new Date(due.getTime() + daysAfterDue * DAY + 6.25 * 60 * 60 * 1000);

describe("late fine", () => {
  it("dates the bill on the last fine-free day", () => {
    expect(fineDueDate(new Date("2026-09-17T00:00:00.000Z"), 5).toISOString()).toBe(
      "2026-09-21T00:00:00.000Z",
    );
  });

  it("charges nothing on the due day, then rate × days", () => {
    const base = { baseAmount: 8000, dueDate: due, enabledAt: null, mode: "PER_DAY_AMOUNT" as const, rate: 50 };

    expect(lateFineLine({ ...base, now: nepalNoon(0) })).toBeNull();
    expect(lateFineLine({ ...base, now: nepalNoon(3) })).toMatchObject({
      amount: 150,
      description: "Late fine — Rs 50 a day × 3 days",
    });
  });

  it("rounds a percent rule once a day and names the rate", () => {
    const line = lateFineLine({
      baseAmount: 8250,
      dueDate: due,
      enabledAt: null,
      mode: "PER_DAY_PERCENT",
      now: nepalNoon(2),
      rate: 1,
    });

    expect(line).toMatchObject({
      amount: 166,
      description: "Late fine — 1% of Rs 8,250 a day (Rs 83) × 2 days",
    });
  });

  it("never fines days before the fine was switched on", () => {
    const line = lateFineLine({
      baseAmount: 8000,
      dueDate: due,
      enabledAt: nepalNoon(10),
      mode: "PER_DAY_AMOUNT",
      now: nepalNoon(12),
      rate: 50,
    });

    expect(line?.amount).toBe(100);
  });

  it("keeps a running fine on the rate it started at, and rewrites one line", () => {
    const invoice = {
      _id: undefined as never,
      dueDate: due,
      lines: [
        { amount: 8000, basis: "SCHEDULE" },
        { amount: 100, basis: "FINE", fineMode: "PER_DAY_AMOUNT" as const, fineRate: 50 },
      ],
      totalAmount: 8100,
    };

    const next = refineInvoice(invoice, { enabledAt: null, mode: "PER_DAY_AMOUNT", rate: 200 }, nepalNoon(4));

    expect(next?.totalAmount).toBe(8200);
    expect(next?.lines.filter((line) => line.basis === "FINE")).toHaveLength(1);
    expect(refineInvoice({ ...invoice, ...next! }, { enabledAt: null, mode: "PER_DAY_AMOUNT", rate: 200 }, nepalNoon(4))).toBeNull();
  });
});
