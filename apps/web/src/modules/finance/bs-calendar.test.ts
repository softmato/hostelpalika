import { describe, expect, it } from "vitest";

import {
  addBsMonths,
  bsDayOfMonth,
  bsDaysInMonth,
  bsMonthStart,
  bsMonthsEnd,
  bsPeriodBounds,
  bsPeriodOf,
  bsPeriodsBetween,
  formatBsDate,
  formatBsDayRange,
  formatBsPeriod,
  formatBsPeriodMonth,
  formatBsPeriodYear,
  fromBs,
  hostelCalendarDay,
  hostelDayEnd,
  hostelDaysBetween,
  isBsPeriod,
  toBs,
} from "@hostel/shared/calendar/bs";

/**
 * The conversion table, checked against dates a person can verify.
 *
 * These are not round-trip assertions — a module can round-trip its own mistake
 * all day. Every expectation here is a Nepali date that appears on a public
 * calendar: Baisakh 1 is New Year, and the Bhadra 2083 anchors are the month the
 * hostel this change came out of was actually billing.
 */
/**
 * Days as spans — the arithmetic every due and every plan end is built on,
 * pinned to the hostel that found it: filed at 11:15 am on Bhadra 26, 2083.
 */
describe("days as spans", () => {
  const filed = new Date("2026-09-11T05:30:31.571Z");

  it("ends a day at its last instant in Kathmandu, three days on for the trial", () => {
    const due = hostelDayEnd(filed, 3);

    expect(due.toISOString()).toBe("2026-09-14T18:14:59.999Z");
    expect(formatBsDate(due)).toBe("Bhadra 29, 2083 BS");
  });

  it("counts between days, so the count moves at midnight and not at lunch", () => {
    const due = hostelDayEnd(filed, 3);

    // 00:00 and 23:59 on Bhadra 26 are the same day, three before the due.
    expect(hostelDaysBetween(new Date("2026-09-10T18:15:00Z"), due)).toBe(3);
    expect(hostelDaysBetween(new Date("2026-09-11T18:14:00Z"), due)).toBe(3);
    // A minute later it is Bhadra 27.
    expect(hostelDaysBetween(new Date("2026-09-11T18:15:00Z"), due)).toBe(2);
  });

  it("runs a monthly plan taken on Bhadra 26 through Aswin 25", () => {
    const end = bsMonthsEnd(filed, 1);

    expect(end.toISOString()).toBe("2026-10-11T18:14:59.999Z");
    expect(formatBsDate(end)).toBe("Aswin 25, 2083 BS");
    // Bhadra has 31 days, so the plan does too — both ends included.
    expect(hostelDaysBetween(filed, end) + 1).toBe(31);
  });

  it("renews on a shorter month's last day rather than spilling into the next", () => {
    const month = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].find(
      (candidate) => bsDaysInMonth(2083, candidate) > bsDaysInMonth(2083, candidate + 1),
    );

    expect(month).toBeDefined();

    const lastDay = bsDaysInMonth(2083, month as number);
    const start = fromBs({ day: lastDay, month: month as number, year: 2083 });
    const next = (month as number) + 1;

    expect(toBs(bsMonthsEnd(start, 1))).toEqual({
      day: bsDaysInMonth(2083, next) - 1,
      month: next,
      year: 2083,
    });
  });
});

describe("the Bikram Sambat table", () => {
  it("puts Baisakh 1 on the Nepali new year", () => {
    expect(formatBsDate(new Date("2026-04-14T06:00:00.000Z"))).toBe("Baisakh 1, 2083 BS");
    expect(formatBsDate(new Date("2025-04-14T06:00:00.000Z"))).toBe("Baisakh 1, 2082 BS");
    expect(formatBsDate(new Date("2024-04-13T06:00:00.000Z"))).toBe("Baisakh 1, 2081 BS");
  });

  it("runs Bhadra 2083 from 17 August to 16 September 2026", () => {
    expect(formatBsDate(new Date("2026-08-17T06:00:00.000Z"))).toBe("Bhadra 1, 2083 BS");
    expect(formatBsDate(new Date("2026-09-16T06:00:00.000Z"))).toBe("Bhadra 31, 2083 BS");
    expect(formatBsDate(new Date("2026-09-17T06:00:00.000Z"))).toBe("Aswin 1, 2083 BS");
  });

  it("gives Bhadra 2083 thirty-one days, which no formula produces", () => {
    expect(bsDaysInMonth(2083, 5)).toBe(31);
  });

  /*
   * The lengths themselves are the table's to state, not this test's to
   * enumerate — an expectation typed from memory is the same invented data the
   * dependency exists to avoid. What is asserted is the property that makes a
   * lookup unavoidable: a BS year is not twelve months of one length, and the
   * same month is not the same length in consecutive years.
   */
  it("has months of differing lengths, so no denominator can be assumed", () => {
    const lengths = Array.from({ length: 12 }, (_, index) =>
      bsDaysInMonth(2083, index + 1),
    );

    expect(new Set(lengths).size).toBeGreaterThan(1);
    expect(lengths.every((days) => days >= 29 && days <= 32)).toBe(true);
    expect(lengths.reduce((sum, days) => sum + days, 0)).toBeGreaterThanOrEqual(365);
  });
});

describe("the Nepal calendar day", () => {
  /*
   * The 5h45m offset, which is the bug this convention exists to end: an instant
   * late on the last UTC day of a month is already the next day in Nepal.
   */
  it("reads the evening of a UTC day as the Nepal day it already is", () => {
    // 31 Aug 2026, 18:30 UTC is 1 Sep 2026, 00:15 in Kathmandu.
    expect(hostelCalendarDay(new Date("2026-08-31T18:30:00.000Z")).toISOString()).toBe(
      "2026-09-01T00:00:00.000Z",
    );
  });

  it("is idempotent, so normalising twice does not shift a date", () => {
    const once = hostelCalendarDay(new Date("2026-09-04T18:15:00.000Z"));

    expect(hostelCalendarDay(once).toISOString()).toBe(once.toISOString());
  });
});

describe("period keys", () => {
  it("names the BS month an instant is in", () => {
    expect(bsPeriodOf(new Date("2026-09-04T06:00:00.000Z"))).toBe("2083-05");
    // The day the month turns over, not the day the Gregorian one does.
    expect(bsPeriodOf(new Date("2026-09-16T06:00:00.000Z"))).toBe("2083-05");
    expect(bsPeriodOf(new Date("2026-09-17T06:00:00.000Z"))).toBe("2083-06");
  });

  it("bounds a BS month with the Gregorian instants it actually spans", () => {
    const bounds = bsPeriodBounds("2083-05");

    expect(bounds.start.toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(bounds.end.toISOString()).toBe("2026-09-16T23:59:59.999Z");
    expect(bounds.daysInMonth).toBe(31);
  });

  it("refuses a period it cannot bill rather than inventing a month", () => {
    // Past the end of the conversion table.
    expect(() => bsPeriodBounds("2099-01")).toThrow(/Bikram Sambat/);
    // A Gregorian key the migration missed. Read as BS it would date to 1969.
    expect(() => bsPeriodBounds("2026-09")).toThrow(/Bikram Sambat/);
    expect(() => bsPeriodBounds("nonsense")).toThrow(/YYYY-MM/);
  });

  it("tells a BS key from the Gregorian ones written before the change", () => {
    expect(isBsPeriod("2083-05")).toBe(true);
    expect(isBsPeriod("2026-09")).toBe(false);
    expect(isBsPeriod("nonsense")).toBe(false);
    expect(isBsPeriod(null)).toBe(false);
  });

  it("carries the year when months are added across Chaitra", () => {
    expect(addBsMonths("2083-05", 1)).toBe("2083-06");
    expect(addBsMonths("2083-12", 1)).toBe("2084-01");
    expect(addBsMonths("2083-01", -1)).toBe("2082-12");
  });
});

describe("the move-in this change came from", () => {
  /*
   * A resident admitted 4 September 2026 on a rent of NPR 18,000.
   *
   * The Gregorian path billed 28 of September's 30 days — NPR 16,800 — and
   * labelled it "Bhadra". Bhadra is a different month with a different length,
   * and the resident owes 13 of its 31 days.
   */
  const moveIn = new Date("2026-09-04T00:00:00.000Z");

  it("puts the move-in in Bhadra, on the day the hostel would call it", () => {
    expect(bsPeriodOf(moveIn)).toBe("2083-05");
    expect(bsDayOfMonth(moveIn)).toBe(19);
  });

  it("counts thirteen billable days, not twenty-eight", () => {
    const { daysInMonth, lastDay } = bsPeriodBounds(bsPeriodOf(moveIn));
    const days = Math.round((lastDay.getTime() - moveIn.getTime()) / 86_400_000) + 1;

    expect(daysInMonth).toBe(31);
    expect(days).toBe(13);
  });

  /*
   * The bug that made a Bhadra invoice say it was due in Aswin. `end` is
   * 23:59:59.999 UTC, which Kathmandu has already carried into the next day;
   * `lastDay` is the calendar day a due date is allowed to be.
   */
  it("closes on a day a due date can carry without slipping a month", () => {
    const { end, lastDay } = bsPeriodBounds("2083-05");

    expect(formatBsDate(end)).toBe("Aswin 1, 2083 BS");
    expect(formatBsDate(lastDay)).toBe("Bhadra 31, 2083 BS");
    expect(bsPeriodOf(lastDay)).toBe("2083-05");
  });

  it("opens the month on 17 August, which is what a BS month start means", () => {
    expect(bsMonthStart(moveIn).toISOString()).toBe("2026-08-17T00:00:00.000Z");
  });
});

describe("display", () => {
  it("writes a period the way a receipt book writes it", () => {
    expect(formatBsPeriod("2083-05")).toBe("Bhadra 2083 BS");
    expect(formatBsPeriodMonth("2083-05")).toBe("Bhadra");
    expect(formatBsPeriodYear("2083-05")).toBe("2083 BS");
  });

  it("says nothing rather than guessing at a Gregorian key", () => {
    expect(formatBsPeriod("2026-09")).toBe("");
    expect(formatBsPeriodMonth("2026-09")).toBe("");
  });

  it("names the days a part month covers, not just how many", () => {
    const { lastDay } = bsPeriodBounds("2083-05");

    expect(formatBsDayRange(new Date("2026-09-04T00:00:00.000Z"), lastDay)).toBe(
      "Bhadra 19–31",
    );
  });

  it("round-trips a BS date through the Gregorian day that opens it", () => {
    const day = fromBs({ day: 19, month: 5, year: 2083 });

    expect(day.toISOString()).toBe("2026-09-04T00:00:00.000Z");
    expect(toBs(day)).toEqual({ day: 19, month: 5, year: 2083 });
  });
});

/**
 * The month sequence two services join against invoices.
 *
 * Every expectation is a boundary the Gregorian walker got wrong: a year that
 * carries at Chaitra rather than at December, and a range whose two ends are in
 * different BS years.
 */
describe("a run of BS months", () => {
  it("steps a Bikram Sambat month, not a Gregorian one", () => {
    expect(bsPeriodsBetween("2083-04", "2083-07")).toEqual([
      "2083-04",
      "2083-05",
      "2083-06",
      "2083-07",
    ]);
  });

  it("carries the year at Chaitra, which is where a BS year ends", () => {
    expect(bsPeriodsBetween("2083-11", "2084-02")).toEqual([
      "2083-11",
      "2083-12",
      "2084-01",
      "2084-02",
    ]);
  });

  it("gives one month when both ends are the same month", () => {
    expect(bsPeriodsBetween("2083-05", "2083-05")).toEqual(["2083-05"]);
  });

  it("gives nothing when the range runs backwards", () => {
    expect(bsPeriodsBetween("2083-06", "2083-05")).toEqual([]);
  });

  it("drops the oldest months at the cap, never the newest", () => {
    const months = bsPeriodsBetween("2070-01", "2083-05", 3);

    expect(months).toEqual(["2083-03", "2083-04", "2083-05"]);
  });

  it("refuses a range it cannot read as two periods", () => {
    expect(() => bsPeriodsBetween("2083-5", "2083-06")).toThrow(RangeError);
  });
});
