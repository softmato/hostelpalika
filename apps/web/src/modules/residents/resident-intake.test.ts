import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import type { FeeScheduleRecord } from "@/modules/finance/fee-schedule.service";
import { fromBs } from "@hostel/shared/calendar/bs";
import { joiningPayable, periodOfDate, quoteIntake } from "@/modules/residents/resident-intake.service";

/**
 * Bhadra 2083 — 17 August to 16 September 2026, 31 days.
 *
 * Move-ins are written as BS days because that is what a period is now. The
 * previous fixtures said "20 August", which is Bhadra *4* — so keeping the
 * literal would have quietly changed every expected figure while looking like it
 * had not moved.
 */
const bhadra = (day: number) => fromBs({ day, month: 5, year: 2083 });

/**
 * The intake quote, as arithmetic.
 *
 * Every case here is one somebody will actually walk into the office with: a
 * hostel that has not written a rate card yet, a room type nobody thought to
 * price, a referral code against a hostel that offers no discount, and a
 * discount left standing after the fee it came off was lowered.
 */

const scheduleId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0f1");

function schedule(overrides: Partial<FeeScheduleRecord> = {}): FeeScheduleRecord {
  return {
    _id: scheduleId,
    admissionFee: 5000,
    depositAmount: 8000,
    effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
    effectiveTo: null,
    hostelId: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0f2"),
    rates: [{ bedType: "FOUR_SHARING", monthlyAmount: 6000 }],
    referralAdmissionDiscount: 1500,
    ...overrides,
  };
}

const hostel = {
  pricing: { admissionFee: 9999, currency: "NPR" },
  roomConfigurations: [{ monthlyRent: 7777, roomType: "Four Sharing" }],
};

describe("intake quote", () => {
  it("adds form fees separately without discounting them for referrals", () => {
    const result = quoteIntake({ hostel, roomType: "Four Sharing", referralCode: "FRIEND", referralCodeActive: true, schedule: schedule({ formFee: 500 }) });
    expect(result.formFee).toBe(500);
    expect(result.admissionPayable).toBe(3500);
    expect(joiningPayable(result)).toBe(12000);
  });

  it("uses the listed form fee before a rate card exists, and allows a card to remove it", () => {
    const input = { hostel: { ...hostel, pricing: { ...hostel.pricing, formFee: 250 } }, roomType: "Four Sharing", referralCodeActive: false };
    expect(quoteIntake({ ...input, schedule: null }).formFee).toBe(250);
    expect(quoteIntake({ ...input, schedule: schedule({ formFee: 0 }) }).formFee).toBe(0);
  });
  it("prices the rent from the rate card, not the room's listed rent", () => {
    const result = quoteIntake({
      hostel,
      referralCodeActive: false,
      roomType: "Four Sharing",
      schedule: schedule(),
    });

    // 7777 is what the owner typed into their listing when they signed up;
    // 6000 is what billing will actually invoice. Quoting the listing price at
    // the door is how a resident ends up arguing with their first bill.
    expect(result.monthlyRent).toBe(6000);
    expect(result.rentBasis).toBe("SCHEDULE");
    expect(result.admissionFee).toBe(5000);
    expect(result.depositAmount).toBe(8000);
  });

  it("falls back to the room configuration when no rate card covers the move-in", () => {
    const result = quoteIntake({
      hostel,
      referralCodeActive: false,
      roomType: "Four Sharing",
      schedule: null,
    });

    expect(result).toMatchObject({
      admissionFee: 9999,
      feeScheduleId: null,
      monthlyRent: 7777,
      rentBasis: "ROOM_CONFIGURATION",
    });
  });

  it("reports an unpriced room type rather than quoting zero", () => {
    const result = quoteIntake({
      hostel,
      referralCodeActive: false,
      // Real data from the development database. It does not say how many people
      // share, and two and five differ by thousands — so nothing prices it.
      roomType: "Shared",
      schedule: schedule(),
    });

    expect(result.bedType).toBeNull();
    expect(result.monthlyRent).toBeNull();
    expect(result.rentBasis).toBe("UNPRICED");
  });

  it("takes the referral discount off the admission fee only", () => {
    const result = quoteIntake({
      hostel,
      referralCode: "hh-asha1",
      referralCodeActive: true,
      roomType: "Four Sharing",
      schedule: schedule(),
    });

    expect(result.referral).toMatchObject({
      applied: true,
      code: "HH-ASHA1",
      discount: 1500,
      reason: null,
    });
    expect(result.admissionPayable).toBe(3500);
    // The rent is untouched: a referral is a one-time thank-you, not a standing
    // rate that makes this resident permanently cheaper than the next bed.
    expect(result.monthlyRent).toBe(6000);
  });

  it("ignores a code that is not live in this hostel, and says so", () => {
    const result = quoteIntake({
      hostel,
      referralCode: "MADEUP",
      referralCodeActive: false,
      roomType: "Four Sharing",
      schedule: schedule(),
    });

    expect(result.referral.applied).toBe(false);
    expect(result.admissionPayable).toBe(5000);
    expect(result.referral.reason).toMatch(/not active/i);
  });

  it("explains a valid code that earns nothing rather than looking broken", () => {
    const result = quoteIntake({
      hostel,
      referralCode: "HH-ASHA1",
      referralCodeActive: true,
      roomType: "Four Sharing",
      schedule: schedule({ referralAdmissionDiscount: 0 }),
    });

    expect(result.referral.applied).toBe(false);
    expect(result.referral.reason).toMatch(/no referral discount/i);
    // The referrer is still credited — the link is made regardless of money.
    expect(result.referral.code).toBe("HH-ASHA1");
  });

  it("never lets the discount exceed the fee it comes off", () => {
    // A card written before the validation rule existed, or one whose admission
    // fee was lowered afterwards without the discount following it.
    const result = quoteIntake({
      hostel,
      referralCode: "HH-ASHA1",
      referralCodeActive: true,
      roomType: "Four Sharing",
      schedule: schedule({ admissionFee: 1000, referralAdmissionDiscount: 4000 }),
    });

    expect(result.referral.discount).toBe(1000);
    // Not negative: an invoice that owes somebody money for moving in.
    expect(result.admissionPayable).toBe(0);
  });

  it("has nothing to discount when the hostel levies no admission fee", () => {
    const result = quoteIntake({
      hostel: { pricing: {}, roomConfigurations: [] },
      referralCode: "HH-ASHA1",
      referralCodeActive: true,
      roomType: "Four Sharing",
      schedule: schedule({ admissionFee: 0 }),
    });

    expect(result.admissionFee).toBe(0);
    expect(result.referral.discount).toBe(0);
    expect(result.referral.reason).toMatch(/no admission fee/i);
  });

  it("prices the move-in month from the move-in day, not as a whole month", () => {
    // 6000 a month, arriving on Bhadra 20: twelve days of a thirty-one-day
    // month. The figure the warden reads out at the desk has to be the one the
    // invoice raises seconds later, which is why both come from
    // `computeInvoiceAmount`.
    const result = quoteIntake({
      hostel,
      moveInDate: bhadra(20),
      referralCodeActive: false,
      roomType: "Four Sharing",
      schedule: schedule(),
    });

    expect(result.firstMonth).toEqual({
      amount: 2323,
      billableDays: 12,
      dayRange: "Bhadra 20–31",
      daysInMonth: 31,
      period: "2083-05",
      prorated: true,
    });
  });

  it("does not call a full first month pro-rated", () => {
    // Somebody arriving on the 1st owes the whole rent, and a "pro-rated" flag
    // that is true for them is a caption nobody can explain.
    const result = quoteIntake({
      hostel,
      moveInDate: bhadra(1),
      referralCodeActive: false,
      roomType: "Four Sharing",
      schedule: schedule(),
    });

    expect(result.firstMonth).toMatchObject({
      amount: 6000,
      billableDays: 31,
      prorated: false,
    });
  });

  it("has no first month to quote when the room type is unpriced", () => {
    // A confident zero would read as a free month. `null` is the same answer
    // `monthlyRent` gives, and the screen already knows how to draw it.
    const result = quoteIntake({
      hostel: { pricing: {}, roomConfigurations: [] },
      moveInDate: bhadra(20),
      referralCodeActive: false,
      roomType: "Nobody Priced This",
      schedule: schedule(),
    });

    expect(result.rentBasis).toBe("UNPRICED");
    expect(result.firstMonth).toBeNull();
  });

  it("reads the move-in month in the hostel's own day, not in UTC", () => {
    /*
     * This asserted UTC, and UTC is the bug. Nepal is UTC+05:45, so the last
     * five and three-quarter hours of every UTC day are already the next day on
     * the wall of the hostel doing the admitting. Reading it as the day before
     * priced the intake off the previous rate card and put the first invoice in
     * a month that had already ended — prorated to its final day.
     *
     * The boundary is now Bhadra 31 to Aswin 1, which is 16/17 September 2026 —
     * a month boundary the Gregorian calendar does not have anywhere near.
     */
    expect(periodOfDate(new Date("2026-09-16T23:30:00.000Z"))).toBe("2083-06");

    // And the ordinary midnight-local move-in, which is what a date picker in
    // Nepal actually sends for "Aswin 1".
    expect(periodOfDate(new Date("2026-09-16T18:15:00.000Z"))).toBe("2083-06");

    // Still Bhadra right up to the local rollover.
    expect(periodOfDate(new Date("2026-09-16T18:14:00.000Z"))).toBe("2083-05");
  });

  it("prices the move-in month from the day the resident arrived, not the day before", () => {
    /*
     * The number this was reported as: a resident who moved in on 3 September
     * was billed a day too many, because "3 September" reaches the server as
     * `2026-09-02T18:15:00.000Z` and every reader counts UTC days.
     *
     * 3 September 2026 is **Bhadra 18, 2083**. Bhadra 18 to Bhadra 31 is 14 of
     * 31 days, so at 18,000 a month the first bill is 8,129 — not the 16,800
     * this used to assert, which was 28 of September's 30 days against a month
     * the hostel's books do not keep.
     */
    const result = quoteIntake({
      hostel: { pricing: {}, roomConfigurations: [] },
      moveInDate: new Date("2026-09-02T18:15:00.000Z"),
      referralCodeActive: false,
      roomType: "Single",
      schedule: schedule({ rates: [{ bedType: "SINGLE", monthlyAmount: 18000 }] }),
    });

    expect(result.firstMonth).toMatchObject({
      amount: 8129,
      billableDays: 14,
      dayRange: "Bhadra 18–31",
      daysInMonth: 31,
      period: "2083-05",
      prorated: true,
    });

    // Fifteen days would be the off-by-one this whole normalisation exists to
    // stop: it would read the instant as Bhadra 17 and charge a day too many.
    expect(result.firstMonth!.billableDays).not.toBe(15);
  });
});
