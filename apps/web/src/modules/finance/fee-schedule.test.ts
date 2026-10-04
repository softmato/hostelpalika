/**
 * Fee schedule, charge resolution and proration — Block 1 item 1.3 of
 * docs/FINANCE_IMPLEMENTATION_PLAN.md (target §3.3–§3.5).
 *
 * Two properties this file exists to hold:
 *
 * 1. **No silent zero.** The current chain
 *    `resident.monthlyFee || input.defaultAmount || 0` (current §5.1 A2) bills a
 *    misconfigured resident nothing, and nobody finds out until someone asks in
 *    November. Every unpriceable case here raises instead.
 * 2. **One proration rule.** The matrix view prorates a mid-month move-in and
 *    the bulk fee run charges full (current §7.8), so a resident's bill depends
 *    on which screen an admin opened first. There is one rule, and move-out
 *    prorates too — which nothing does today.
 */
import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import { fromBs } from "@hostel/shared/calendar/bs";
import {
  computeInvoiceAmount,
  periodBounds,
  resolveBedType,
  resolveMonthlyCharge,
  type BillableResident,
  rateForRoomType,
  type FeeScheduleRecord,
} from "@/modules/finance/fee-schedule.service";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const scheduleId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b1");

const schedule: FeeScheduleRecord = {
  _id: scheduleId,
  admissionFee: 5000,
  depositAmount: 10000,
  effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
  effectiveTo: null,
  hostelId,
  rates: [
    { bedType: "SINGLE", monthlyAmount: 18000 },
    { bedType: "DOUBLE_SHARING", monthlyAmount: 14000 },
    { bedType: "TRIPLE_SHARING", monthlyAmount: 12000 },
    { bedType: "DORMITORY", monthlyAmount: 8000 },
  ],
};

function resident(overrides: Partial<BillableResident> = {}): BillableResident {
  return {
    _id: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0c1"),
    bedType: null,
    monthlyFee: null,
    moveInDate: new Date("2025-06-01T00:00:00.000Z"),
    roomType: "Triple Sharing",
    ...overrides,
  };
}

describe("resolveMonthlyCharge — target §3.4 step by step", () => {
  it("takes the per-resident override when one is set", () => {
    const charge = resolveMonthlyCharge(resident({ monthlyFee: 9000 }), schedule);

    expect(charge).toMatchObject({ amount: 9000, basis: "OVERRIDE" });
    expect(charge.feeScheduleId).toBeNull();
  });

  /**
   * Zero is a legitimate override — a staff member's child, a comped room — and
   * "not set" is not. Testing falsiness instead of nullness is precisely the bug
   * that makes a misconfigured resident indistinguishable from a free one.
   */
  it("honours a zero override rather than falling through to the schedule", () => {
    expect(resolveMonthlyCharge(resident({ monthlyFee: 0 }), schedule)).toMatchObject({
      amount: 0,
      basis: "OVERRIDE",
    });
  });

  it("does not need a schedule when an override is set", () => {
    expect(resolveMonthlyCharge(resident({ monthlyFee: 9000 }), null)).toMatchObject({
      amount: 9000,
      basis: "OVERRIDE",
    });
  });

  it("prices from the schedule via the resident's bed type", () => {
    expect(resolveMonthlyCharge(resident({ bedType: "SINGLE" }), schedule)).toMatchObject(
      { amount: 18000, basis: "SCHEDULE", bedType: "SINGLE", feeScheduleId: scheduleId },
    );
  });

  // bedType is a new nullable field that nothing backfills (item 1.1), so the
  // free text the hostel actually maintains has to keep working.
  it("falls back to normalising roomType when bedType is unset", () => {
    expect(
      resolveMonthlyCharge(
        resident({ bedType: null, roomType: "Two Sharing" }),
        schedule,
      ),
    ).toMatchObject({ amount: 14000, bedType: "DOUBLE_SHARING" });
  });

  it("prefers a stored bedType over the roomType text", () => {
    expect(
      resolveMonthlyCharge(
        resident({ bedType: "DORMITORY", roomType: "Single Room" }),
        schedule,
      ),
    ).toMatchObject({ amount: 8000, bedType: "DORMITORY" });
  });

  it("raises FEE_SCHEDULE_MISSING when no schedule covers the period", () => {
    expect(() => resolveMonthlyCharge(resident(), null)).toThrow(
      expect.objectContaining({ errorCode: "FEE_SCHEDULE_MISSING", status: 422 }),
    );
  });

  it("raises BED_TYPE_NOT_PRICED when the room type does not map", () => {
    expect(() =>
      resolveMonthlyCharge(resident({ roomType: "Shared" }), schedule),
    ).toThrow(expect.objectContaining({ errorCode: "BED_TYPE_NOT_PRICED", status: 422 }));
  });

  it("raises BED_TYPE_NOT_PRICED when the schedule has no rate for that bed type", () => {
    // The schedule above prices four of the five bed types.
    expect(() =>
      resolveMonthlyCharge(resident({ bedType: "FOUR_SHARING" }), schedule),
    ).toThrow(expect.objectContaining({ errorCode: "BED_TYPE_NOT_PRICED" }));
  });

  it("never returns zero as a fallback", () => {
    for (const broken of [
      resident({ roomType: "Deluxe" }),
      resident({ bedType: "FOUR_SHARING" }),
    ]) {
      expect(() => resolveMonthlyCharge(broken, schedule)).toThrow();
    }
  });

  it("rejects a fractional override rather than billing it", () => {
    expect(() =>
      resolveMonthlyCharge(resident({ monthlyFee: 9000.5 }), schedule),
    ).toThrow(/whole number of rupees/);
  });

  it("reports the bed type it could not price, for the owner-facing message", () => {
    expect(() =>
      resolveMonthlyCharge(resident({ roomType: "Shared" }), schedule),
    ).toThrow(/"Shared"/);
  });
});

describe("resolveBedType", () => {
  it("returns null when neither field resolves", () => {
    expect(resolveBedType(resident({ bedType: null, roomType: "Deluxe" }))).toBeNull();
  });
});

describe("periodBounds", () => {
  /*
   * The lengths are the conversion table's, not this file's. A Bikram Sambat
   * month is 29 to 32 days depending on the *year*, which is the whole reason
   * the arithmetic cannot be a formula — Jestha is 31 days in 2083 and 32 in
   * 2084, and any hard-coded denominator is wrong in one of them.
   */
  it.each([
    ["2083-03", 32], // Asar — the long one
    ["2083-05", 31], // Bhadra
    ["2083-07", 30], // Kartik
    ["2083-08", 29], // Mangsir — the short one
  ] as const)("counts the days in %s as %s", (period, days) => {
    expect(periodBounds(period).daysInMonth).toBe(days);
  });

  it("gives the same month a different length in a different year", () => {
    expect(periodBounds("2083-02").daysInMonth).toBe(31);
    expect(periodBounds("2084-02").daysInMonth).toBe(32);
  });

  it("bounds the month in UTC so a run gives the same answer anywhere", () => {
    const { end, lastDay, start } = periodBounds("2083-05");

    // Bhadra 2083 is 17 Aug to 16 Sep 2026. Neither end is the 1st or the 30th
    // of anything, which is exactly what the Gregorian bounds got wrong.
    expect(start.toISOString()).toBe("2026-08-17T00:00:00.000Z");
    expect(lastDay.toISOString()).toBe("2026-09-16T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-16T23:59:59.999Z");
  });

  it("rejects a malformed period", () => {
    expect(() => periodBounds("2083-13")).toThrow(/YYYY-MM/);
  });

  it("rejects a Gregorian period rather than dating it to 1969", () => {
    expect(() => periodBounds("2026-08")).toThrow(/Bikram Sambat/);
  });
});

/**
 * Bhadra 2083 — 17 August to 16 September 2026, 31 days.
 *
 * The month the resident whose bill started this change was actually living in.
 * Move-ins are written as BS days, because that is what they are: a warden does
 * not think "the resident arrived on 4 September", they think "Bhadra 19".
 */
const BHADRA = "2083-05";
const bhadra = (day: number) => fromBs({ day, month: 5, year: 2083 });
const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

describe("computeInvoiceAmount — proration, target §3.5", () => {
  it("charges the full month for a resident present throughout", () => {
    expect(computeInvoiceAmount(12000, d("2025-01-01"), null, BHADRA)).toMatchObject({
      amount: 12000,
      prorationBasis: null,
    });
  });

  it("charges the full month for a move-in on the 1st", () => {
    expect(computeInvoiceAmount(12000, bhadra(1), null, BHADRA)).toMatchObject({
      amount: 12000,
      billableDays: 31,
    });
  });

  it("prorates a mid-month move-in", () => {
    // Bhadra 14 → 18 of 31 days. 12000 / 31 * 18 = 6967.74 → 6968.
    expect(computeInvoiceAmount(12000, bhadra(14), null, BHADRA)).toMatchObject({
      amount: 6968,
      billableDays: 18,
      prorationBasis: "Bhadra 14–31 · 18 of 31 days",
    });
  });

  /*
   * The bill this whole change came out of: a resident admitted 4 September
   * 2026 on NPR 18,000. The Gregorian path billed 28 of September's 30 days —
   * NPR 16,800 — and printed "Bhadra" over it. Bhadra 19 to Bhadra 31 is 13 of
   * 31 days, which is less than half of what was charged.
   */
  it("bills the move-in that exposed the Gregorian month", () => {
    expect(computeInvoiceAmount(18000, bhadra(19), null, BHADRA)).toMatchObject({
      amount: 7548,
      billableDays: 13,
      prorationBasis: "Bhadra 19–31 · 13 of 31 days",
    });
  });

  // Nothing in the current system does this at all: a resident leaving on the
  // 8th is charged the whole month.
  it("prorates a mid-month move-out", () => {
    expect(
      computeInvoiceAmount(12000, d("2025-01-01"), bhadra(8), BHADRA),
    ).toMatchObject({
      amount: 3097,
      billableDays: 8,
      prorationBasis: "Bhadra 1–8 · 8 of 31 days",
    });
  });

  it("prorates a move-in and move-out in the same month", () => {
    // Bhadra 10 to Bhadra 20 inclusive → 11 days.
    expect(computeInvoiceAmount(12000, bhadra(10), bhadra(20), BHADRA)).toMatchObject({
      amount: 4258,
      billableDays: 11,
    });
  });

  it("charges a single day of tenancy", () => {
    expect(computeInvoiceAmount(12000, bhadra(31), bhadra(31), BHADRA)).toMatchObject({
      amount: 387,
      billableDays: 1,
      prorationBasis: "Bhadra 31 · 1 of 31 days",
    });
  });

  it("charges nothing before the resident arrives", () => {
    // Aswin 1 — the day after Bhadra ends, which the Gregorian bounds would
    // have counted as still inside "September".
    expect(
      computeInvoiceAmount(12000, fromBs({ day: 1, month: 6, year: 2083 }), null, BHADRA),
    ).toMatchObject({ amount: 0, prorationBasis: "not yet resident" });
  });

  it("charges nothing after the resident has left", () => {
    expect(
      computeInvoiceAmount(
        12000,
        d("2025-01-01"),
        fromBs({ day: 20, month: 4, year: 2083 }),
        BHADRA,
      ),
    ).toMatchObject({ amount: 0, prorationBasis: "already moved out" });
  });

  it("charges the full month when tenancy spans it entirely", () => {
    expect(
      computeInvoiceAmount(
        12000,
        fromBs({ day: 1, month: 4, year: 2083 }),
        fromBs({ day: 30, month: 6, year: 2083 }),
        BHADRA,
      ),
    ).toMatchObject({ amount: 12000, billableDays: 31, prorationBasis: null });
  });

  it("handles a 29-day month", () => {
    // Mangsir 2083 is 29 days, so 14 of them is 5793.10… — not half, and not
    // rounded to half.
    const mangsir = (day: number) => fromBs({ day, month: 8, year: 2083 });

    expect(computeInvoiceAmount(12000, mangsir(1), mangsir(14), "2083-08")).toMatchObject(
      { amount: 5793, billableDays: 14, prorationBasis: "Mangsir 1–14 · 14 of 29 days" },
    );
  });

  it("handles a 32-day month", () => {
    // Asar 2083. No Gregorian month is this long, and a denominator carried
    // over from one would overcharge every day of it.
    const asar = (day: number) => fromBs({ day, month: 3, year: 2083 });

    expect(computeInvoiceAmount(12000, asar(1), asar(16), "2083-03")).toMatchObject({
      amount: 6000,
      billableDays: 16,
      prorationBasis: "Asar 1–16 · 16 of 32 days",
    });
  });

  it("charges the full month for all 29 days of a short month", () => {
    expect(
      computeInvoiceAmount(
        12000,
        fromBs({ day: 1, month: 8, year: 2083 }),
        fromBs({ day: 29, month: 8, year: 2083 }),
        "2083-08",
      ),
    ).toMatchObject({ amount: 12000, prorationBasis: null });
  });

  it("leaves no proration basis on a full month, so invoices stay uncluttered", () => {
    expect(computeInvoiceAmount(12000, null, null, BHADRA).prorationBasis).toBeNull();
  });

  it("names the days charged, not just how many", () => {
    expect(computeInvoiceAmount(12000, bhadra(14), null, BHADRA).prorationBasis).toBe(
      "Bhadra 14–31 · 18 of 31 days",
    );
  });

  it("always produces a whole amount", () => {
    for (let day = 1; day <= 31; day += 1) {
      const { amount } = computeInvoiceAmount(12345, bhadra(day), null, BHADRA);

      expect(Number.isInteger(amount)).toBe(true);
    }
  });

  it("rejects a fractional monthly charge", () => {
    expect(() => computeInvoiceAmount(12000.5, null, null, BHADRA)).toThrow(
      /whole number of rupees/,
    );
  });

  // The move-out-before-move-in case can only arise from bad data, but it must
  // bill zero rather than a negative amount.
  it("charges nothing when move-out precedes move-in", () => {
    expect(computeInvoiceAmount(12000, bhadra(20), bhadra(10), BHADRA)).toMatchObject({
      amount: 0,
    });
  });
});

/**
 * Rates are keyed by the hostel's own room type.
 *
 * Bed-type keying is why the platform stored a price twice. `normalizeBedType`
 * returns null for real room types — `"Shared"` is live data and does not say
 * how many people share — so a rate card could not price every room a hostel
 * rents, `roomConfigurations[].monthlyRent` had to stay as a second store, and
 * the two drifted until one hostel advertised 18,000 and invoiced 174,000.
 */
describe("rateForRoomType", () => {
  it("keeps attached bathrooms separately priced and does not borrow the standard room rate", () => {
    const rates = { ...schedule, rates: [
      { roomType: "Double Sharing", monthlyAmount: 8000 },
      { roomType: "Double Sharing — Attached Bathroom", monthlyAmount: 11000 },
    ] };
    expect(rateForRoomType(rates, "Double Sharing")?.monthlyAmount).toBe(8000);
    expect(rateForRoomType(rates, "Double Sharing — Attached Bathroom")?.monthlyAmount).toBe(11000);
    expect(rateForRoomType({ ...rates, rates: rates.rates.slice(0, 1) }, "Double Sharing — Attached Bathroom")).toBeNull();
  });
  const byRoomType: FeeScheduleRecord = {
    ...schedule,
    rates: [
      { bedType: "SINGLE", monthlyAmount: 18000, roomType: "Single Room" },
      { bedType: null, monthlyAmount: 7500, roomType: "Shared" },
    ],
  };

  it("matches the room type the hostel actually uses", () => {
    expect(rateForRoomType(byRoomType, "Single Room")?.monthlyAmount).toBe(18000);
  });

  it("prices a room type that maps to no bed type at all", () => {
    // The whole reason the second store existed.
    expect(rateForRoomType(byRoomType, "Shared")?.monthlyAmount).toBe(7500);
  });

  it("ignores spelling and case, because a room type is text somebody typed", () => {
    expect(rateForRoomType(byRoomType, "  single room ")?.monthlyAmount).toBe(18000);
  });

  it("falls back to bed type for a card written before the re-key", () => {
    // Nothing has to be migrated before it can be billed.
    expect(rateForRoomType(schedule, "Single")?.monthlyAmount).toBe(18000);
  });

  it("does not match a re-keyed rate on bed type", () => {
    /*
     * "Private" and "Single Room" both normalise to SINGLE. Matching a rate that
     * names a room type on its bed type instead would hand back whichever came
     * first — the ambiguity room-type keying exists to end.
     */
    expect(rateForRoomType(byRoomType, "Private")).toBeNull();
  });

  it("returns null rather than guessing when nothing matches", () => {
    expect(rateForRoomType(byRoomType, "Penthouse")).toBeNull();
    expect(rateForRoomType(null, "Single Room")).toBeNull();
  });

  it("prices a resident off the room-type rate, through the same lookup", () => {
    // The billing run and the intake quote must be one arithmetic on one row.
    const charge = resolveMonthlyCharge(resident({ roomType: "Shared" }), byRoomType);

    expect(charge).toMatchObject({ amount: 7500, basis: "SCHEDULE" });
  });
});
