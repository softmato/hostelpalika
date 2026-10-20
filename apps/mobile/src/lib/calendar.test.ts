import { describe, expect, it } from "vitest";

import {
  calendarExample,
  formatAgoIn,
  formatDateIn,
  formatDateLongIn,
  formatDateTimeIn,
  formatPeriodIn,
  formatRelativeDayIn,
} from "@/lib/calendar";

/**
 * The cases worth having are the ones where the two calendars disagree about
 * something other than the digits: the fallbacks, and the parts of a string
 * that must **not** change when the calendar does.
 *
 * `2026-08-18T06:00:00.000Z` is 11:45 am in Kathmandu — comfortably inside the
 * day in both zones, so a failure here is a calendar bug rather than the
 * UTC+05:45 boundary that `format.test.ts` already covers.
 */
const NOON_NPT = "2026-08-18T06:00:00.000Z";

describe("formatDateIn", () => {
  it("writes the same instant in either calendar", () => {
    expect(formatDateIn("AD", NOON_NPT)).toBe("18 Aug 2026");
    expect(formatDateIn("BS", NOON_NPT)).toBe("Bhadra · 2083-05-02");
  });

  it("keeps the em dash for a missing date in both", () => {
    expect(formatDateIn("AD", null)).toBe("—");
    expect(formatDateIn("BS", null)).toBe("—");
  });
});

describe("formatDateLongIn", () => {
  it("names the weekday after the date, in either calendar", () => {
    // 18 Aug 2026 was a Tuesday. Bikram Sambat renumbers the days; it does not
    // reorder them, so both calendars must agree on the weekday.
    expect(formatDateLongIn("BS", NOON_NPT)).toBe("Bhadra · 2083-05-02 · Tuesday");
    expect(formatDateLongIn("AD", NOON_NPT)).toBe("18 Aug 2026 · Tuesday");
  });

  it("reads the weekday off the Nepal day, not the device's", () => {
    // 18:30 UTC on a Tuesday is already Wednesday in Kathmandu (UTC+05:45), and
    // the date half says so — the weekday must move with it rather than being
    // taken from the phone's own idea of the day.
    expect(formatDateLongIn("BS", "2026-08-18T18:30:00.000Z")).toBe(
      "Bhadra · 2083-05-03 · Wednesday",
    );
  });

  it("stays one em dash for a date it cannot parse", () => {
    expect(formatDateLongIn("BS", null)).toBe("—");
    expect(formatDateLongIn("AD", "not-a-date")).toBe("—");
  });
});

describe("formatDateTimeIn", () => {
  it("changes the calendar and leaves the clock alone", () => {
    // Bikram Sambat is a calendar, not a way of telling the time — the same
    // 12-hour clock is read in both, so only the half before the comma moves.
    expect(formatDateTimeIn("AD", NOON_NPT)).toBe("18 Aug 2026, 11:45 am");
    expect(formatDateTimeIn("BS", NOON_NPT)).toBe("Bhadra · 2083-05-02, 11:45 am");
  });

  it("does not staple a time onto a missing date", () => {
    expect(formatDateTimeIn("BS", undefined)).toBe("—");
  });
});

describe("formatPeriodIn", () => {
  it("names the billing month in whichever calendar the portal is set to", () => {
    // `2083-04` is Shrawan, the month the invoice is keyed by. The Gregorian
    // side is the rounded one now — Shrawan 2083 is 17 July to 16 August 2026,
    // and August covers more of it.
    expect(formatPeriodIn("BS", "2083-04")).toBe("Shrawan 2083 BS");
    expect(formatPeriodIn("AD", "2083-04")).toBe("August 2026");
  });

  it("falls back to the Gregorian name rather than printing nothing", () => {
    // `formatPeriodBs` answers "" when its table cannot reach the period. A
    // month chip whose label vanished would be a tap target with no name on it.
    expect(formatPeriodIn("BS", "not-a-period")).toBe("not-a-period");
    expect(formatPeriodIn("BS", null)).toBe("—");
  });
});

describe("formatRelativeDayIn", () => {
  const now = new Date(NOON_NPT);

  it("leaves Today and Yesterday alone — a day is the same day in both", () => {
    expect(formatRelativeDayIn("BS", NOON_NPT, now)).toBe("Today");
    expect(
      formatRelativeDayIn("BS", "2026-08-17T06:00:00.000Z", now),
    ).toBe("Yesterday");
  });

  it("writes anything older in the reader's calendar", () => {
    const old = "2026-08-01T06:00:00.000Z";

    expect(formatRelativeDayIn("AD", old, now)).toBe("1 Aug 2026");
    expect(formatRelativeDayIn("BS", old, now)).toBe("Shrawan · 2083-04-16");
  });
});

describe("formatAgoIn", () => {
  const now = new Date(NOON_NPT);

  it("leaves the elapsed half alone", () => {
    const twoHoursAgo = "2026-08-18T04:00:00.000Z";

    expect(formatAgoIn("AD", twoHoursAgo, now)).toBe("2 hrs ago");
    expect(formatAgoIn("BS", twoHoursAgo, now)).toBe("2 hrs ago");
  });

  it("converts the date it falls back to past a week", () => {
    const lastMonth = "2026-07-20T06:00:00.000Z";

    expect(formatAgoIn("AD", lastMonth, now)).toBe("20 Jul 2026");
    expect(formatAgoIn("BS", lastMonth, now)).toBe("Shrawan · 2083-04-04");
  });

  it("does not mistake a six-day-old row for a date", () => {
    // The "6 days ago" branch and the date branch are distinguished by
    // comparing against `formatDate`, so this is the case that would break if
    // that comparison ever matched too eagerly.
    expect(formatAgoIn("BS", "2026-08-14T06:00:00.000Z", now)).toBe(
      "4 days ago",
    );
  });
});

describe("calendarExample", () => {
  it("writes the day it is given, so the picker never shows a stale date", () => {
    // The regression this guards: the examples used to be two string literals,
    // and the Dates section went on offering "18 Aug 2026" all the way into
    // Bhadra.
    expect(calendarExample("AD", new Date(NOON_NPT))).toBe("18 Aug 2026");
    expect(calendarExample("BS", new Date(NOON_NPT))).toBe("Bhadra · 2083-05-02");

    const later = new Date("2026-09-02T06:00:00.000Z");

    expect(calendarExample("AD", later)).toBe("2 Sep 2026");
    expect(calendarExample("BS", later)).toBe("Bhadra · 2083-05-17");
  });
});
