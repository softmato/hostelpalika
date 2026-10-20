import { describe, expect, it } from "vitest";

import {
  daysUntil,
  formatAgo,
  formatAmount,
  formatDate,
  formatDateBoth,
  formatDateBs,
  formatDateTime,
  formatDayMonth,
  formatDayMonthBs,
  formatDueLabel,
  formatMoney,
  formatPeriod,
  formatPeriodBoth,
  formatPeriodBs,
  formatPeriodMonth,
  formatPeriodMonthBs,
  formatPeriodYear,
  formatPeriodYearBs,
  formatRelativeDay,
  formatTime,
  formatYear,
  formatYearBs,
  greetingFor,
  heroAmountSize,
  humanizeEnum,
} from "@/lib/format";

/**
 * The Nepal-time cases are the ones worth having.
 *
 * NPT is UTC+05:45, so every "which day is this" question has a 5-hour-45
 * window each evening where UTC and Kathmandu disagree. Reading UTC there
 * shows yesterday's menu and dates a payment to the wrong day.
 */
describe("money", () => {
  it("groups thousands and drops empty paisa", () => {
    expect(formatAmount(8500)).toBe("8,500");
    expect(formatAmount(1234567)).toBe("1,234,567");
    expect(formatMoney(8500)).toBe("Rs 8,500");
  });

  it("keeps paisa when the amount actually has some", () => {
    // A balance that does not add up is what a resident calls about.
    expect(formatAmount(1200.5)).toBe("1,200.50");
    expect(formatMoney(0.05)).toBe("Rs 0.05");
  });

  it("renders zero and negatives rather than hiding them", () => {
    expect(formatAmount(0)).toBe("0");
    expect(formatMoney(-450)).toBe("Rs -450");
  });

  it("shows a dash for missing or non-finite values, not NaN", () => {
    expect(formatMoney(null)).toBe("—");
    expect(formatMoney(undefined)).toBe("—");
    expect(formatMoney(Number.NaN)).toBe("—");
  });
});

describe("dates in Nepal time", () => {
  it("rolls a late-evening UTC instant into the next Kathmandu day", () => {
    // 2026-08-16T18:30:00Z is 2026-08-17 00:15 in Kathmandu.
    expect(formatDate("2026-08-16T18:30:00.000Z")).toBe("17 Aug 2026");
    expect(formatTime("2026-08-16T18:30:00.000Z")).toBe("12:15 am");
  });

  it("formats midday and midnight without a 0 or 13 o'clock", () => {
    expect(formatTime("2026-08-16T06:15:00.000Z")).toBe("12:00 pm");
    expect(formatDateTime("2026-08-16T06:15:00.000Z")).toBe("16 Aug 2026, 12:00 pm");
  });

  it("says Today and Yesterday against a Nepal-day boundary", () => {
    const now = new Date("2026-08-16T10:00:00.000Z");

    expect(formatRelativeDay("2026-08-16T02:00:00.000Z", now)).toBe("Today");
    expect(formatRelativeDay("2026-08-15T09:00:00.000Z", now)).toBe("Yesterday");
    expect(formatRelativeDay("2026-08-10T09:00:00.000Z", now)).toBe("10 Aug 2026");
  });

  it("compares due dates as whole days, so 'due today' lasts all day", () => {
    const now = new Date("2026-08-16T23:00:00.000Z");

    expect(daysUntil("2026-08-17T04:00:00.000Z", now)).toBe(0);
    expect(formatDueLabel("2026-08-17T04:00:00.000Z", now)).toBe("Due today");
  });

  it("counts overdue days forward", () => {
    const now = new Date("2026-08-16T06:00:00.000Z");

    expect(formatDueLabel("2026-08-15T06:00:00.000Z", now)).toBe("1 day overdue");
    expect(formatDueLabel("2026-08-12T06:00:00.000Z", now)).toBe("4 days overdue");
    expect(formatDueLabel("2026-08-17T06:00:00.000Z", now)).toBe("Due tomorrow");
    expect(formatDueLabel("2026-08-20T06:00:00.000Z", now)).toBe("Due in 4 days");
  });

  it("returns a dash rather than 'Invalid Date' for junk", () => {
    expect(formatDate("not a date")).toBe("—");
    expect(formatDateTime(undefined)).toBe("—");
    expect(formatDueLabel(null)).toBeNull();
  });
});

describe("labels", () => {
  it("expands an invoice period", () => {
    expect(formatPeriod("2026-08")).toBe("August 2026");
  });

  it("passes an unrecognised period through instead of guessing", () => {
    expect(formatPeriod("Shrawan")).toBe("Shrawan");
    expect(formatPeriod("")).toBe("—");
  });

  it("turns a shouted server enum into a sentence", () => {
    expect(humanizeEnum("PENDING_PROOF")).toBe("Pending proof");
    expect(humanizeEnum("PAID")).toBe("Paid");
    expect(humanizeEnum(null)).toBe("—");
  });

  it("greets on Kathmandu's clock, not the device's", () => {
    // 18:30 UTC is 00:15 the next day in Nepal — morning, not evening.
    expect(greetingFor(new Date("2026-08-16T18:30:00.000Z"))).toBe("Good morning");
    expect(greetingFor(new Date("2026-08-16T06:15:00.000Z"))).toBe("Good afternoon");
    expect(greetingFor(new Date("2026-08-16T13:00:00.000Z"))).toBe("Good evening");
  });
});

describe("formatDateBs / formatDateBoth", () => {
  it("converts against the Bikram Sambat New Year anchors", () => {
    // The five dates the library was adopted on. BS month lengths vary per year
    // and are tabulated data, so these are the checks that say the table is the
    // real one rather than something that merely looks plausible.
    expect(formatDateBs("2013-04-14T06:00:00.000Z")).toBe("Baisakh · 2070-01-01");
    expect(formatDateBs("2023-04-14T06:00:00.000Z")).toBe("Baisakh · 2080-01-01");
    expect(formatDateBs("2024-04-13T06:00:00.000Z")).toBe("Baisakh · 2081-01-01");
    expect(formatDateBs("2025-04-14T06:00:00.000Z")).toBe("Baisakh · 2082-01-01");
    expect(formatDateBs("2026-04-14T06:00:00.000Z")).toBe("Baisakh · 2083-01-01");
  });

  it("shows both calendars, BS first", () => {
    // BS leads because it is the calendar the hostel quotes; AD follows because
    // it is the one the bank statement and the phone agree on.
    expect(formatDateBoth("2026-08-18T06:00:00.000Z")).toBe("Bhadra · 2083-05-02");
  });

  it("converts on the Nepal day, not the device's", () => {
    // 18:30 UTC is already the next day in Kathmandu (+05:45). A phone left on
    // another timezone must still read the date the hostel means.
    expect(formatDateBs("2026-08-18T18:30:00.000Z")).toBe("Bhadra · 2083-05-03");
  });

  it("returns an em dash for nothing, like every other formatter here", () => {
    expect(formatDateBs(null)).toBe("—");
    expect(formatDateBoth(undefined)).toBe("—");
  });

  /*
   * The two calendars on one row must never disagree about which day it is.
   *
   * `nepali-date-converter` reads the *device-local* getters, so the `Date`
   * handed to it has to carry the Nepal day in its local fields. Building it at
   * noon **UTC** — which is what this did — survives every offset up to +11 and
   * breaks past it: a phone in Auckland or Kiritimati printed the Gregorian
   * date correctly and the Nepali one a day ahead, on the same line.
   *
   * Kathmandu is included so the row that is expected to be right everywhere is
   * visibly the same row.
   */
  it("agrees with the Gregorian date in every timezone a phone can be set to", () => {
    const original = process.env.TZ;

    // `finally`, because a bare restore at the end leaves the clock moved when
    // an expectation fails — and then every later test in the file fails too,
    // hiding the one that actually broke behind a cascade.
    try {
      // The extremes in both directions, plus Nepal itself. Node re-reads `TZ`
      // on assignment, so this genuinely moves the clock rather than mocking it.
      for (const timezone of [
        "Etc/GMT+12",
        "America/Anchorage",
        "Asia/Kathmandu",
        "Pacific/Auckland",
        "Pacific/Kiritimati",
      ]) {
        process.env.TZ = timezone;

        expect(formatDateBoth("2026-08-18T06:00:00.000Z")).toBe(
          "Bhadra · 2083-05-02",
        );
        // And across the Nepal midnight, where the AD side moves too.
        expect(formatDateBoth("2026-08-18T18:30:00.000Z")).toBe(
          "Bhadra · 2083-05-03",
        );
        expect(formatPeriodBs("2083-05")).toBe("Bhadra 2083 BS");
      }
    } finally {
      process.env.TZ = original;
    }
  });
});

/**
 * A period key is a **Bikram Sambat** month now, and this is where that shows.
 *
 * These cases used to feed `2026-08` in and check which BS month covered most
 * of it. The rounding runs the other way today: `2083-05` is Bhadra, the month
 * the hostel actually bills, and Gregorian is the approximation — Bhadra 2083 is
 * 17 August to 16 September 2026, so no single English month names it.
 */
describe("formatPeriodBs", () => {
  it("names the BS month straight off the key, with no conversion at all", () => {
    expect(formatPeriodBs("2083-05")).toBe("Bhadra 2083 BS");
    expect(formatPeriodBs("2083-04")).toBe("Shrawan 2083 BS");
    expect(formatPeriodBs("2083-01")).toBe("Baisakh 2083 BS");
  });

  it("is empty for a period it cannot convert, never a guess", () => {
    expect(formatPeriodBs("not-a-period")).toBe("");
    expect(formatPeriodBs(null)).toBe("");
    expect(formatPeriodBs("2083-13")).toBe("");
  });

  /*
   * A row written before the calendar changed. Reading `2026-08` as Bikram
   * Sambat would date it to 1969, so the BS half is dropped and the Gregorian
   * month it always was is what shows.
   */
  it("leaves a legacy Gregorian key as the Gregorian month it always was", () => {
    expect(formatPeriodBs("2026-08")).toBe("");
    expect(formatPeriod("2026-08")).toBe("August 2026");
  });

  it("names the Gregorian month a BS period mostly falls in", () => {
    // Bhadra 2083 is 15 days of August and 16 of September, so September wins.
    expect(formatPeriod("2083-05")).toBe("September 2026");
    // Shrawan 2083 is 17 Jul to 16 Aug — 15 days of July, 16 of August.
    expect(formatPeriod("2083-04")).toBe("August 2026");
  });

  it("prints both calendars, with the BS half leading the arithmetic", () => {
    expect(formatPeriodBoth("2083-05")).toBe("September 2026 · Bhadra 2083 BS");
    expect(formatPeriodBoth("not-a-period")).toBe("not-a-period");
  });
});

/**
 * The year-less forms, for a row inside a section that already names the year.
 *
 * The invoice list is what they exist for. Under a `2083 BS` heading, a row
 * reading `Bhadra 2083 BS` over `Aswin · 2083-06-15` prints the year three times,
 * and the repetition is what made a billing month over a due date read as a
 * glitch rather than as two different true facts.
 */
describe("the year-less date forms", () => {
  it("names a period's month alone, in either calendar", () => {
    expect(formatPeriodMonthBs("2083-05")).toBe("Bhadra");
    expect(formatPeriodMonth("2083-05")).toBe("September");
  });

  it("names a day without its year, in either calendar", () => {
    // Bhadra 3 2083 — the same instant `formatDateBs` is checked against above.
    expect(formatDayMonth("2026-08-18T18:30:00.000Z")).toBe("19 Aug");
    expect(formatDayMonthBs("2026-08-18T18:30:00.000Z")).toBe("Bhadra 3");
  });

  it("falls back rather than guessing, exactly as the full forms do", () => {
    expect(formatPeriodMonth("not-a-period")).toBe("not-a-period");
    expect(formatPeriodMonthBs("not-a-period")).toBe("");
    // And a legacy Gregorian key keeps its own month rather than shifting 57
    // years, which is what reading it as Bikram Sambat would do.
    expect(formatPeriodMonth("2026-09")).toBe("September");
    expect(formatPeriodMonthBs("2026-09")).toBe("");
    expect(formatDayMonth(null)).toBe("—");
    expect(formatDayMonthBs(null)).toBe("—");
  });
});

/**
 * The group heading a list of months sits under.
 *
 * The two calendars do not share year boundaries, which is the whole reason
 * these exist: the Payments screen grouped on `dueDate.slice(0, 4)` and drew a
 * `2026` heading over a card whose every row said `2083 BS`. Relabelling that
 * grouping would have been just as wrong — `2026` genuinely holds two BS years.
 */
describe("year headings", () => {
  it("answers the two calendars' different years for one instant", () => {
    expect(formatYear("2026-09-05T06:00:00.000Z")).toBe("2026");
    expect(formatYearBs("2026-09-05T06:00:00.000Z")).toBe("2083 BS");
  });

  it("splits one BS year across the two Gregorian years it spans", () => {
    /*
     * The heading question, in the direction it now runs. Baisakh 1 2083 falls
     * on 14 April 2026 and Chaitra 2083 ends in April 2027, so a single BS year
     * genuinely holds two Gregorian ones — which is why a list for a BS reader
     * has to be *grouped* on this and not merely relabelled.
     */
    expect(formatPeriodYearBs("2083-01")).toBe("2083 BS");
    expect(formatPeriodYear("2083-01")).toBe("2026");

    expect(formatPeriodYearBs("2083-12")).toBe("2083 BS");
    expect(formatPeriodYear("2083-12")).toBe("2027");
  });

  it("is empty rather than a guess when it cannot answer", () => {
    expect(formatPeriodYear("not-a-period")).toBe("");
    expect(formatPeriodYearBs("not-a-period")).toBe("");
    expect(formatYear(null)).toBe("");
    expect(formatYearBs(null)).toBe("");
  });
});

describe("formatAgo", () => {
  const now = new Date("2026-08-25T12:00:00.000Z");

  it("answers in the coarsest unit that is still true", () => {
    expect(formatAgo("2026-08-25T11:59:30.000Z", now)).toBe("just now");
    expect(formatAgo("2026-08-25T11:59:00.000Z", now)).toBe("1 min ago");
    expect(formatAgo("2026-08-25T11:20:00.000Z", now)).toBe("40 mins ago");
    expect(formatAgo("2026-08-25T10:00:00.000Z", now)).toBe("2 hrs ago");
    expect(formatAgo("2026-08-24T10:00:00.000Z", now)).toBe("1 day ago");
    expect(formatAgo("2026-08-20T10:00:00.000Z", now)).toBe("5 days ago");
  });

  it("hands back to a date once the arithmetic stops being worth doing", () => {
    expect(formatAgo("2026-07-25T10:00:00.000Z", now)).toBe("25 Jul 2026");
  });

  it("never reports the future for a clock a few minutes fast", () => {
    expect(formatAgo("2026-08-25T12:02:00.000Z", now)).toBe("just now");
  });
});

describe("heroAmountSize", () => {
  it("leaves an ordinary hostel's total at full size", () => {
    expect(heroAmountSize("Rs 1,284,000")).toBe(34);
  });

  it("steps down rather than letting a long total ellipse", () => {
    // `Rs 12,84,…` is not a smaller version of the number, it is a different
    // number — the one truncation a total must never take.
    //
    // The same figures step down at the same sizes they did when the prefix was
    // `NPR`: the thresholds moved with it, deliberately. See the note there.
    expect(heroAmountSize("Rs 128,400,000")).toBe(29);
    expect(heroAmountSize("Rs 1,284,000,000")).toBe(29);
    expect(heroAmountSize("Rs 12,840,000,000")).toBe(24);
  });

  it("has a floor for something absurd", () => {
    expect(heroAmountSize("Rs 1,284,000,000,000")).toBe(20);
  });

  it("does not shrink a dash", () => {
    expect(heroAmountSize("—")).toBe(34);
  });
});
