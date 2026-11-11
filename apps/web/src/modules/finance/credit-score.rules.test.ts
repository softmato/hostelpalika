import { describe, expect, it } from "vitest";

import { bsPeriodBounds } from "@hostel/shared/calendar/bs";

import { claimCounts, pointsForDay, scoreEntries } from "@/modules/finance/credit-score.rules";

const PERIOD = "2083-05";
const start = bsPeriodBounds(PERIOD).start;
const day = (n: number) => new Date(start.getTime() + (n - 1) * 86_400_000 + 6 * 3_600_000);
const invoice = { _id: "inv1", kind: "MONTHLY_RENT", period: PERIOD };

const claim = (id: string, sentDay: number, extra: Record<string, unknown> = {}) => ({
  _id: id,
  createdAt: day(sentDay),
  direction: "CREDIT",
  invoiceId: "inv1",
  occurredAt: day(sentDay),
  settledAt: day(sentDay + 10),
  source: "RESIDENT_CLAIM",
  status: "SETTLED",
  ...extra,
});

describe("credit score (todo B5)", () => {
  it("points by day: 4 → 10, 5 → 8, 7 → 8, 8 → lower", () => {
    expect(pointsForDay(4)).toBe(10);
    expect(pointsForDay(5)).toBe(8);
    expect(pointsForDay(7)).toBe(8);
    expect(pointsForDay(8)).toBeLessThan(8);
    expect(pointsForDay(16)).toBe(2);
  });

  it("a day-2 claim approved late still earns 10", () => {
    const [entry] = scoreEntries([invoice], [claim("e1", 2)]);

    expect(entry).toMatchObject({ day: 2, points: 10 });
  });

  it("desk cash counts from the day the warden records it", () => {
    const [entry] = scoreEntries([invoice], [
      { _id: "e1", direction: "CREDIT", invoiceId: "inv1", occurredAt: day(1), settledAt: day(6), source: "CASH_ENTRY", status: "SETTLED" },
    ]);

    expect(entry).toMatchObject({ day: 6, points: 8 });
  });

  it("one award per bill; rejected, reversed and fee-off earn nothing", () => {
    expect(scoreEntries([invoice], [claim("e1", 9), claim("e2", 3)])).toHaveLength(1);
    expect(scoreEntries([invoice], [claim("e1", 9), claim("e2", 3)])[0]!.points).toBe(10);
    expect(scoreEntries([invoice], [claim("e1", 2, { status: "REJECTED" })])).toEqual([]);
    expect(scoreEntries([invoice], [claim("e1", 2, { reversedByEventId: "r1" })])).toEqual([]);
    expect(scoreEntries([invoice], [claim("e1", 2, { source: "OFFER_PROGRAM" })])).toEqual([]);
    expect(scoreEntries([{ ...invoice, kind: "ADMISSION" }], [claim("e1", 2)])).toEqual([]);
  });

  it("paying before the bill's month is day 1", () => {
    expect(scoreEntries([invoice], [claim("e1", -3)])[0]).toMatchObject({ day: 1, points: 10 });
  });

  it("counts shared and approved claims", () => {
    expect(claimCounts([claim("a", 1), claim("b", 1, { status: "REJECTED" }), claim("c", 1, { status: "PENDING" })])).toEqual({ approved: 1, shared: 3 });
  });
});
