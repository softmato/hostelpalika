import { describe, expect, it } from "vitest";

import { topicsForWrite } from "@/lib/realtime/announce-writes";
import { billedMoveOut } from "@/modules/finance/billing.service";
import { periodBounds } from "@/modules/finance/fee-schedule.service";
import { moveOutDay, unusedDaysCut } from "@/modules/move-checklist/move-out-money";

describe("leaving month", () => {
  it("cuts the days after they leave, in whole rupees, from the bill's own rent", () => {
    // 10 of 30 days stayed on 9,000: 3,000 charged, 6,000 off.
    expect(unusedDaysCut(9000, 30, 10)).toBe(6000);
    expect(unusedDaysCut(8001, 31, 15)).toBe(8001 - Math.round((8001 * 15) / 31));
    expect(unusedDaysCut(9000, 30, 30)).toBe(0);
    expect(unusedDaysCut(9000, 0, 0)).toBe(0);
  });

  it("bills a full-month hostel's leaving month whole, and nothing after it", () => {
    const { lastDay, start } = periodBounds("2083-05");
    const midMonth = new Date(start.getTime() + 9 * 86_400_000);
    const resident = { lastMonthCharge: "FULL_MONTH" as const, moveOutDate: midMonth };

    expect(billedMoveOut(resident, "2083-05")).toBeNull();
    // The next month still sees them gone.
    expect(billedMoveOut(resident, "2083-06")).toBe(midMonth);
    // Till the day keeps the date.
    expect(billedMoveOut({ ...resident, lastMonthCharge: "TILL_DAY" }, "2083-05")).toBe(midMonth);
    expect(lastDay > midMonth).toBe(true);
  });

  it("reads a typed day as that Nepal day's UTC midnight", () => {
    expect(moveOutDay("2026-10-11").toISOString()).toBe("2026-10-11T00:00:00.000Z");
  });
});

describe("live screens", () => {
  it("announces writes, never reads", () => {
    expect(topicsForWrite("POST", "/api/v1/hostel-admin/residents/abc/move-out")).toContain("payments");
    expect(topicsForWrite("GET", "/api/v1/hostel-admin/residents")).toEqual([]);
    expect(topicsForWrite("PATCH", "/api/v1/hostel-admin/rooms")).toContain("rooms");
    expect(topicsForWrite("POST", "/api/v1/auth/login")).toEqual([]);
  });
});

describe("days away", () => {
  it("takes the food figure, or a day of the bill's own rent", async () => {
    const { perDayOff } = await import("@/modules/finance/resident-leave.service");

    expect(perDayOff({ foodPerDay: 150, mode: "FOOD" }, 9000, 30)).toBe(150);
    expect(perDayOff({ foodPerDay: 150, mode: "FULL_DAY" }, 9000, 30)).toBe(300);
    expect(perDayOff({ foodPerDay: 0, mode: "FULL_DAY" }, 9000, 0)).toBe(0);
  });
});
