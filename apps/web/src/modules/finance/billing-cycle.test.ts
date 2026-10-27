import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import { bsCycleBounds, bsCyclePeriodOf } from "@/lib/hostel-day";
import { ordinalDay, planBillingCycle } from "@/modules/finance/billing.service";
import { computeInvoiceAmount, residentPeriodBounds } from "@/modules/finance/fee-schedule.service";

// Bhadra 2083 = 17 Aug – 16 Sep 2026 (31 days); Aswin 1 = 17 Sep 2026.
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);

describe("same-day billing cycle (field review E2)", () => {
  it("runs from the bill day to the day before it next month", () => {
    const bounds = bsCycleBounds("2083-05", 20);

    expect(iso(bounds.start)).toBe("2026-09-05"); // Bhadra 20
    expect(iso(bounds.lastDay)).toBe("2026-10-05"); // Aswin 19
    expect(bounds.daysInMonth).toBe(31);
  });

  it("opens on the month's last day when the month is shorter than the bill day", () => {
    expect(iso(bsCycleBounds("2083-05", 32).start)).toBe("2026-09-16"); // Bhadra 31
  });

  it("finds the bill a day belongs to, which may have opened last month", () => {
    expect(bsCyclePeriodOf(day("2026-09-10"), 20)).toBe("2083-05"); // Bhadra 25
    expect(bsCyclePeriodOf(day("2026-09-01"), 20)).toBe("2083-04"); // Bhadra 16
  });

  it("bills the first span whole and cuts the leaving one by its own days", () => {
    const resident = { billingCycle: "SAME_DAY" as const, moveInDate: day("2026-09-05") };
    const bounds = residentPeriodBounds(resident, "2083-05");

    expect(computeInvoiceAmount(6200, resident.moveInDate, null, "2083-05", bounds)).toMatchObject({
      amount: 6200,
      prorationBasis: null,
    });
    // Leaves Aswin 4 (20 Sep): Bhadra 20 – Aswin 4 = 16 of 31 days.
    expect(computeInvoiceAmount(6200, resident.moveInDate, day("2026-09-20"), "2083-05", bounds)).toMatchObject({
      amount: 3200,
      billableDays: 16,
    });
  });

  it("keeps the calendar month for everyone else", () => {
    const bounds = residentPeriodBounds({ billingCycle: "CALENDAR_MONTH", moveInDate: day("2026-09-05") }, "2083-05");

    expect(iso(bounds.start)).toBe("2026-08-17");
    expect(bounds.daysInMonth).toBe(31);
  });

  it("waits for the bill day, except for the first bill", () => {
    const resident = {
      _id: new Types.ObjectId(),
      billingCycle: "SAME_DAY" as const,
      hostelId: new Types.ObjectId(),
      monthlyFee: 6000,
      moveInDate: day("2026-09-05"),
    };

    const early = planBillingCycle([resident], null, "2083-06", new Map(), undefined, day("2026-09-20"));
    expect(early.skipped).toEqual([{ reason: "NOT_YET_DUE", residentId: resident._id.toString() }]);

    const onTheDay = planBillingCycle([resident], null, "2083-06", new Map(), undefined, day("2026-10-06"));
    expect(onTheDay.plans).toHaveLength(1);
    expect(onTheDay.plans[0]!.amount).toBe(6000);

    const first = planBillingCycle([resident], null, "2083-05", new Map(), undefined, day("2026-09-01"));
    expect(first.plans).toHaveLength(1);
  });

  it("says the bill day the way people do", () => {
    expect([1, 2, 3, 11, 12, 13, 20, 21, 22, 32].map(ordinalDay)).toEqual([
      "1st", "2nd", "3rd", "11th", "12th", "13th", "20th", "21st", "22nd", "32nd",
    ]);
  });
});
