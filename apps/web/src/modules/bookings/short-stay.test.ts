/**
 * Short stays: the daily-rate floor and the settings check (docs/PLANS_BRANCHES_SHORT_STAYS.md
 * item 13). What would go wrong quietly: a daily rate under monthly ÷ 30, which
 * lets short stays undercut the hostel's own residents.
 */
import { describe, expect, it } from "vitest";

import { DEFAULT_BOOKING_CONFIG } from "@/modules/bookings/booking-config";
import { settleBooking, termsFromConfig } from "@/modules/bookings/booking-terms";
import { amountDue, dailyFloor, quoteStay, stayCheckInBy, stayEndsAt } from "@/modules/bookings/short-stay";
import { checkShortStays, type ShortStayRoom } from "@/modules/bookings/short-stay-settings.service";

const rooms: ShortStayRoom[] = [
  { dailyRate: null, floor: dailyFloor(9_000, 20), monthlyRent: 9_000, roomType: "Two Sharing" },
  { dailyRate: null, floor: null, monthlyRent: null, roomType: "Single" },
];
const config = { shortStayMaxNights: 29 };

describe("short stays", () => {
  it("floors a night at monthly ÷ 30 plus the markup, rounded up", () => {
    expect(dailyFloor(9_000, 20)).toBe(360);
    expect(dailyFloor(10_000, 0)).toBe(334);
    expect(dailyFloor(0, 20)).toBe(1);
  });

  it("refuses a rate under the floor, or on a room with no monthly rent", () => {
    expect(() =>
      checkShortStays({ enabled: true, minNights: 1, rates: [{ dailyRate: 359, roomType: "Two Sharing" }] }, rooms, config),
    ).toThrow(/at least Rs 360/);
    expect(() =>
      checkShortStays({ enabled: true, minNights: 1, rates: [{ dailyRate: 900, roomType: "Single" }] }, rooms, config),
    ).toThrow(/monthly rent/);
  });

  it("spells the room the hostel's way and needs a rate to switch on", () => {
    expect(
      checkShortStays({ enabled: true, minNights: 2, rates: [{ dailyRate: 400, roomType: "two sharing" }] }, rooms, config),
    ).toEqual({ enabled: true, minNights: 2, rates: [{ dailyRate: 400, roomType: "Two Sharing" }] });
    expect(() => checkShortStays({ enabled: true, minNights: 1, rates: [] }, rooms, config)).toThrow(/at least one/);
    expect(() => checkShortStays({ enabled: false, minNights: 30, rates: [] }, rooms, config)).toThrow(/at most 29/);
  });
});

describe("a short stay's money", () => {
  const now = new Date("2026-09-27T06:00:00.000Z"); // 11:45 in Kathmandu
  const base = {
    dailyRate: 500,
    holdDays: 7,
    hostelSharePercent: 70,
    maxAdvanceDays: 60,
    maxNights: 29,
    minNights: 2,
    now,
  };

  it("prices the nights and charges one fee per started week of hold", () => {
    const soon = quoteStay({ ...base, moveIn: "2026-10-04", moveOut: "2026-10-07" });

    expect(soon).toMatchObject({ amount: 1_500, holdBlocks: 1, nights: 3 });
    expect(quoteStay({ ...base, moveIn: "2026-10-05", moveOut: "2026-10-07" }).holdBlocks).toBe(2);
    expect(quoteStay({ ...base, moveIn: "2026-09-27", moveOut: "2026-09-29" }).holdBlocks).toBe(1);
    expect(amountDue({ fee: 2 * 630, stay: soon })).toBe(2_760);
  });

  it("refuses dates outside the limits", () => {
    expect(() => quoteStay({ ...base, moveIn: "2026-10-04", moveOut: "2026-10-05" })).toThrow(/at least 2 nights/);
    expect(() => quoteStay({ ...base, moveIn: "2026-10-01", moveOut: "2026-10-31" })).toThrow(/at most 29/);
    expect(() => quoteStay({ ...base, moveIn: "2026-09-26", moveOut: "2026-09-29" })).toThrow(/between today/);
    expect(() => quoteStay({ ...base, moveIn: "2026-11-27", moveOut: "2026-11-29" })).toThrow(/60 days/);
    expect(() => quoteStay({ ...base, moveIn: "2026-10-04", moveOut: "2026-10-04" })).toThrow(/later move-out/);
  });

  it("settles the nights beside the fee: full back before move-in day, one night kept after", () => {
    const stay = quoteStay({ ...base, moveIn: "2026-10-04", moveOut: "2026-10-07" });
    const settle = (ending: Parameters<typeof settleBooking>[0]["ending"], at: Date) =>
      settleBooking({ at, confirmedAt: now, ending, fee: 630, stay, terms: termsFromConfig(DEFAULT_BOOKING_CONFIG) });

    // Declined: fee and nights all back.
    expect(settle("DECLINED", now)).toMatchObject({ kept: 0, refund: 2_130, stayRefund: 1_500 });
    // Checked in: fee split 60/40, nights 70/30.
    expect(settle("CHECKED_IN", now)).toMatchObject({ hostelShare: 378 + 1_050, platformShare: 252 + 450, refund: 0 });
    // No-show keeps one night; the fee follows its own no-show share (0%).
    expect(settle("NO_SHOW", new Date("2026-10-05T19:00:00.000Z"))).toMatchObject({ stayKept: 500, stayRefund: 1_000 });
    // Cancelling on the move-in day is treated like a no-show for the nights.
    expect(settle("CANCELLED_BY_USER", new Date("2026-10-04T03:00:00.000Z")).stayRefund).toBe(1_000);
    // The day before, the nights come back whole.
    expect(settle("CANCELLED_BY_USER", new Date("2026-10-03T03:00:00.000Z")).stayRefund).toBe(1_500);
  });

  it("gives until the end of the day after move-in to check in", () => {
    const stay = quoteStay({ ...base, moveIn: "2026-10-04", moveOut: "2026-10-07" });

    expect(stayCheckInBy(stay).toISOString()).toBe("2026-10-05T18:14:59.999Z");
    expect(stayEndsAt(stay).toISOString()).toBe("2026-10-07T18:14:59.999Z");
  });
});
