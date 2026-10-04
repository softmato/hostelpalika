import { describe, expect, it } from "vitest";

import { projectSchedule } from "@/modules/finance/listing-projection.service";

/**
 * The listing is a view of the rate card.
 *
 * The case every one of these is drawn from: a hostel advertised a single room
 * at 18,000 on its public page while its rate card said 180,000, and a resident
 * was invoiced 174,000 for their first month. Both numbers were stored, both
 * were read correctly, and nothing compared them.
 */

const hostel = {
  pricing: { admissionFee: 5000, currency: "NPR" },
  roomConfigurations: [
    { monthlyRent: 18000, roomType: "Single Room" },
    { monthlyRent: 10000, roomType: "Four Sharing" },
  ],
};

describe("projectSchedule", () => {
  it("writes the card's rents onto the room configurations", () => {
    const result = projectSchedule(hostel, {
      rates: [
        { monthlyAmount: 20000, roomType: "Single Room" },
        { monthlyAmount: 11000, roomType: "Four Sharing" },
      ],
    });

    expect(result.roomConfigurations).toEqual([
      { monthlyRent: 20000, roomType: "Single Room" },
      { monthlyRent: 11000, roomType: "Four Sharing" },
    ]);
  });

  it("recomputes the advertised range from the projected rents", () => {
    // The range is a third store of the same price. Derived, it cannot drift.
    const result = projectSchedule(hostel, {
      rates: [
        { monthlyAmount: 20000, roomType: "Single Room" },
        { monthlyAmount: 11000, roomType: "Four Sharing" },
      ],
    });

    expect(result).toMatchObject({ monthlyRentMax: 20000, monthlyRentMin: 11000 });
  });

  it("projects form fees including zero, so removing one updates the listing", () => {
    for (const formFee of [300, 0]) {
      expect(projectSchedule(hostel, { formFee, rates: [] }).formFee).toBe(formFee);
    }
  });

  it("carries the admission fee across, so the listing cannot quote a different one", () => {
    const result = projectSchedule(hostel, {
      admissionFee: 2000,
      rates: [{ monthlyAmount: 18000, roomType: "Single Room" }],
    });

    expect(result.admissionFee).toBe(2000);
  });

  it("leaves the admission fee alone when the card does not name one", () => {
    // Absent is not zero. A card that says nothing about admission must not
    // wipe a fee the hostel advertises and collects.
    const result = projectSchedule(hostel, {
      rates: [{ monthlyAmount: 18000, roomType: "Single Room" }],
    });

    expect(result.admissionFee).toBeUndefined();
  });

  it("matches room types through spelling and case", () => {
    // "single room" and "Single Room" are one room type. Anything else makes the
    // key as brittle as the free text it is drawn from.
    const result = projectSchedule(hostel, {
      rates: [{ monthlyAmount: 20000, roomType: "single  room" }],
    });

    expect(result.roomConfigurations[0]).toEqual({
      monthlyRent: 20000,
      roomType: "Single Room",
    });
  });

  it("keeps the listed rent for a room type the card does not price", () => {
    // Blanking it would take a hostel's advertised price off a page people
    // search by, because finance has not got to that room type yet.
    const result = projectSchedule(hostel, {
      rates: [{ monthlyAmount: 20000, roomType: "Single Room" }],
    });

    expect(result.roomConfigurations[1]).toEqual({
      monthlyRent: 10000,
      roomType: "Four Sharing",
    });
    expect(result.unmatched.onListingOnly).toEqual(["Four Sharing"]);
  });

  it("reports a rate for a room type the hostel does not list", () => {
    // Usually a room type renamed on one screen and not the other. A rate
    // nobody can book is worth surfacing rather than silently ignoring.
    const result = projectSchedule(hostel, {
      rates: [{ monthlyAmount: 9000, roomType: "Dormitory" }],
    });

    expect(result.unmatched.onCardOnly).toEqual(["Dormitory"]);
  });

  it("ignores a legacy rate that carries only a bed type", () => {
    /*
     * A card written before rates were re-keyed prices correctly through
     * `rateForRoomType`, but it cannot be projected: `SINGLE` does not say which
     * of a hostel's room-type strings it belongs to, and guessing is what put
     * two numbers on one bed in the first place. The migration backfills these.
     */
    const result = projectSchedule(hostel, {
      rates: [{ bedType: "SINGLE" as const, monthlyAmount: 180000 }],
    });

    expect(result.roomConfigurations).toEqual(hostel.roomConfigurations);
    expect(result.monthlyRentMin).toBe(10000);
  });

  it("leaves the range unset for a hostel that has priced nothing", () => {
    const result = projectSchedule(
      { roomConfigurations: [{ monthlyRent: 0, roomType: "Shared" }] },
      { rates: [] },
    );

    expect(result.monthlyRentMin).toBeUndefined();
    expect(result.monthlyRentMax).toBeUndefined();
  });

  it("prices a room type no bed type can express", () => {
    /*
     * `normalizeBedType("Shared")` is null — two and five people sharing are
     * both plausible and the rents differ by thousands. Under bed-type keying
     * this hostel could not be priced by a rate card at all, which is why the
     * listing had to stay a second store. Room-type keying is what removes it.
     */
    const result = projectSchedule(
      { roomConfigurations: [{ monthlyRent: 0, roomType: "Shared" }] },
      { rates: [{ monthlyAmount: 7500, roomType: "Shared" }] },
    );

    expect(result.roomConfigurations).toEqual([
      { monthlyRent: 7500, roomType: "Shared" },
    ]);
    expect(result.monthlyRentMin).toBe(7500);
  });
});
