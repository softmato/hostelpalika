import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Role } from "@/lib/roles";
import { fromBs } from "@hostel/shared/calendar/bs";

/**
 * When a rate card may be written, replaced or dropped.
 *
 * Every case here comes from one owner's afternoon. They pressed a "next month"
 * button that added thirty days, got a card starting on the 17th, saw it badged
 * **Active** while a different card was actually billing their residents at ten
 * times the rate — and then could not correct any of it, because the only guard
 * compared dates and refused anything not later than what they had just saved.
 */

const mocks = vi.hoisted(() => ({
  auditFinanceAction: vi.fn(),
  connectToDatabase: vi.fn(),
  invoiceCountDocuments: vi.fn(),
  projectScheduleOntoListing: vi.fn(),
  scheduleCreate: vi.fn(),
  scheduleDeleteOne: vi.fn(),
  scheduleFind: vi.fn(),
  scheduleFindOne: vi.fn(),
  scheduleUpdateOne: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ connectToDatabase: mocks.connectToDatabase }));
vi.mock("@/lib/transaction", () => ({ inTransaction: (fn: () => Promise<unknown>) => fn() }));

vi.mock("@/modules/finance/audit-finance", () => ({
  auditFinanceAction: mocks.auditFinanceAction,
}));

vi.mock("@/modules/finance/listing-projection.service", () => ({
  projectScheduleOntoListing: mocks.projectScheduleOntoListing,
}));

vi.mock("@hostel/db/models/FeeSchedule", () => ({
  FeeScheduleModel: {
    create: mocks.scheduleCreate,
    deleteOne: mocks.scheduleDeleteOne,
    find: mocks.scheduleFind,
    findOne: mocks.scheduleFindOne,
    updateOne: mocks.scheduleUpdateOne,
  },
}));

vi.mock("@hostel/db/models/Invoice", () => ({
  InvoiceModel: { countDocuments: mocks.invoiceCountDocuments },
}));

import {
  createFeeSchedule,
  deleteFeeSchedule,
  labelSchedules,
  scheduleStanding,
} from "@/modules/finance/fee-schedule.service";

const hostelId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0a1");
const currentId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b1");
const previousId = new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0b2");

const principal = {
  hostelIds: [hostelId.toString()],
  role: Role.HOSTEL_ADMIN,
  userId: "64f0f0f0f0f0f0f0f0f0f0c1",
};

/**
 * "Today" for every case: 3 September 2026, the day this was reported — which
 * in the calendar the hostel keeps its books in is **Bhadra 18, 2083**.
 *
 * Every month below is therefore a Bikram Sambat month, because that is what a
 * rate card now starts on. Bhadra 2083 is the running month (17 Aug - 16 Sep
 * 2026), Aswin is next (17 Sep - 17 Oct), Kartik the one after. Writing them as
 * `bs(...)` rather than as Gregorian literals is the point: an owner setting
 * rates picks "from Aswin", not "from 17 September".
 */
const NOW = new Date("2026-09-03T04:00:00.000Z");

/** A day of a Bikram Sambat month of 2083, as the instant it opens. */
const bs = (month: number, day: number) => fromBs({ day, month, year: 2083 });

const BHADRA = 5;
const ASWIN = 6;
const KARTIK = 7;
const MANGSIR = 8;
const SHRAWAN = 4;

function card(overrides: Record<string, unknown> = {}) {
  return {
    _id: currentId,
    admissionFee: 2000,
    // Bhadra 1 — the month that is billing right now.
    effectiveFrom: bs(BHADRA, 1),
    effectiveTo: null,
    hostelId,
    rates: [{ bedType: "SINGLE", monthlyAmount: 18000, roomType: "Single Room" }],
    ...overrides,
  };
}

function lean<T>(value: T) {
  return { lean: vi.fn().mockResolvedValue(value), sort: vi.fn().mockReturnThis() };
}

const input = (effectiveFrom: string) => ({
  effectiveFrom: new Date(effectiveFrom),
  rates: [{ monthlyAmount: 18000, roomType: "Single Room" }],
});

/** The document handed to `FeeScheduleModel.create`. */
const created = () => mocks.scheduleCreate.mock.calls[0]?.[0];

describe("scheduleStanding", () => {
  it("calls a card for a future month upcoming, however open it is", () => {
    // The bug on the screen: `effectiveTo: null` was read as "in force", so a
    // card starting 3 October was badged Active on 3 September.
    expect(
      scheduleStanding({ effectiveFrom: bs(ASWIN, 1), effectiveTo: null }, NOW),
    ).toBe("upcoming");
  });

  it("calls the open card current once its month has started", () => {
    expect(
      scheduleStanding({ effectiveFrom: bs(BHADRA, 1), effectiveTo: null }, NOW),
    ).toBe("current");
  });

  it("calls a closed card past", () => {
    expect(
      scheduleStanding(
        { effectiveFrom: bs(SHRAWAN, 1), effectiveTo: bs(SHRAWAN, 31) },
        NOW,
      ),
    ).toBe("past");
  });
});

describe("createFeeSchedule — when rates may change", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(NOW);
    mocks.scheduleCreate.mockImplementation(async (doc: Record<string, unknown>) => ({
      ...doc,
      _id: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0d1"),
    }));
    mocks.scheduleUpdateOne.mockResolvedValue({ acknowledged: true });
    mocks.scheduleDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mocks.projectScheduleOntoListing.mockResolvedValue(null);
  });

  it("pulls a mid-month start back to the first of that month", async () => {
    // "17 Aswin" on the owner's screen. A card cannot begin mid-month: the
    // billing run gives a whole month to one card.
    mocks.scheduleFindOne.mockReturnValue(lean(card()));

    await createFeeSchedule(hostelId, input(bs(ASWIN, 17).toISOString()), principal);

    expect(created().effectiveFrom.toISOString()).toBe(bs(ASWIN, 1).toISOString());
  });

  it("refuses to change the month that is already billing", async () => {
    mocks.scheduleFindOne.mockReturnValue(lean(card()));

    await expect(
      createFeeSchedule(hostelId, input(bs(BHADRA, 1).toISOString()), principal),
    ).rejects.toMatchObject({ errorCode: "FEE_SCHEDULE_MONTH_LOCKED" });
    expect(mocks.scheduleCreate).not.toHaveBeenCalled();
  });

  it("lets a hostel with no card at all start one this month", async () => {
    // Until one exists nobody can be billed, so the first card is the exception.
    mocks.scheduleFindOne.mockReturnValue(lean(null));

    await createFeeSchedule(hostelId, input(bs(BHADRA, 14).toISOString()), principal);

    expect(created().effectiveFrom.toISOString()).toBe(bs(BHADRA, 1).toISOString());
  });

  it("replaces an upcoming card rather than refusing a second one", async () => {
    /*
     * The trap. October's rates were set wrong and could not be corrected until
     * October, because the guard only asked whether the new date was later. A
     * card that has priced nothing is not history.
     */
    mocks.scheduleFindOne.mockReturnValue(lean(card({ effectiveFrom: bs(ASWIN, 1) })));

    await createFeeSchedule(hostelId, input(bs(ASWIN, 1).toISOString()), principal);

    expect(mocks.scheduleDeleteOne).toHaveBeenCalledWith({ _id: currentId });
    expect(mocks.scheduleUpdateOne).not.toHaveBeenCalled();
    expect(created().effectiveFrom.toISOString()).toBe(bs(ASWIN, 1).toISOString());
  });

  it("replaces it however the owner spelled the date", async () => {
    // Aswin 22 and Aswin 1 are the same card.
    mocks.scheduleFindOne.mockReturnValue(lean(card({ effectiveFrom: bs(ASWIN, 1) })));

    await createFeeSchedule(hostelId, input(bs(ASWIN, 22).toISOString()), principal);

    expect(mocks.scheduleDeleteOne).toHaveBeenCalledWith({ _id: currentId });
  });

  it("closes a card that has started instead of replacing it", async () => {
    // This one is billing residents and an invoice may carry its id.
    mocks.scheduleFindOne.mockReturnValue(lean(card()));

    await createFeeSchedule(hostelId, input(bs(KARTIK, 1).toISOString()), principal);

    expect(mocks.scheduleDeleteOne).not.toHaveBeenCalled();
    expect(mocks.scheduleUpdateOne).toHaveBeenCalledWith(
      { _id: currentId },
      { $set: { effectiveTo: expect.any(Date) } },
    );
  });

  it("refuses a month earlier than one already scheduled", async () => {
    mocks.scheduleFindOne.mockReturnValue(lean(card({ effectiveFrom: bs(MANGSIR, 1) })));

    await expect(
      createFeeSchedule(hostelId, input(bs(KARTIK, 1).toISOString()), principal),
    ).rejects.toMatchObject({ errorCode: "FEE_SCHEDULE_MISSING" });
  });

  it("writes the new rents onto the public listing", async () => {
    mocks.scheduleFindOne.mockReturnValue(lean(card()));

    await createFeeSchedule(hostelId, input(bs(ASWIN, 1).toISOString()), principal);

    expect(mocks.projectScheduleOntoListing).toHaveBeenCalled();
  });
});

describe("deleteFeeSchedule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.setSystemTime(NOW);
    mocks.invoiceCountDocuments.mockResolvedValue(0);
    mocks.scheduleDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mocks.scheduleUpdateOne.mockResolvedValue({ acknowledged: true });
    mocks.projectScheduleOntoListing.mockResolvedValue(null);
  });

  it("drops upcoming rates and re-opens the card they displaced", async () => {
    /*
     * The half that makes delete safe. Opening a card closed its predecessor;
     * deleting it has to undo that, or a delete on *next* month's rates leaves
     * the hostel with no open card and stops billing for everybody.
     */
    mocks.scheduleFindOne
      .mockReturnValueOnce(lean(card({ effectiveFrom: bs(ASWIN, 1) })))
      .mockReturnValueOnce(
        lean(
          card({
            _id: previousId,
            effectiveFrom: bs(BHADRA, 1),
            effectiveTo: bs(BHADRA, 31),
          }),
        ),
      );

    const result = await deleteFeeSchedule(hostelId, currentId.toString(), principal);

    expect(mocks.scheduleDeleteOne).toHaveBeenCalledWith({ _id: currentId });
    expect(mocks.scheduleUpdateOne).toHaveBeenCalledWith(
      { _id: previousId },
      { $set: { effectiveTo: null } },
    );
    expect(result.restoredId).toBe(previousId.toString());
  });

  it("puts the listing back to the rates that are running again", async () => {
    mocks.scheduleFindOne
      .mockReturnValueOnce(lean(card({ effectiveFrom: bs(ASWIN, 1) })))
      .mockReturnValueOnce(lean(card({ _id: previousId })));

    await deleteFeeSchedule(hostelId, currentId.toString(), principal);

    expect(mocks.projectScheduleOntoListing).toHaveBeenCalled();
  });

  it("refuses rates that have already started", async () => {
    mocks.scheduleFindOne.mockReturnValue(lean(card()));

    await expect(
      deleteFeeSchedule(hostelId, currentId.toString(), principal),
    ).rejects.toMatchObject({ errorCode: "FEE_SCHEDULE_MONTH_LOCKED" });
    expect(mocks.scheduleDeleteOne).not.toHaveBeenCalled();
  });

  it("refuses rates that have priced an invoice, whatever their dates say", async () => {
    // An orphaned `feeScheduleId` makes "what was this resident's rent in
    // March?" unanswerable, which is the question versioning exists to answer.
    mocks.scheduleFindOne.mockReturnValue(lean(card({ effectiveFrom: bs(ASWIN, 1) })));
    mocks.invoiceCountDocuments.mockResolvedValue(2);

    await expect(
      deleteFeeSchedule(hostelId, currentId.toString(), principal),
    ).rejects.toMatchObject({ errorCode: "FEE_SCHEDULE_IN_USE" });
    expect(mocks.scheduleDeleteOne).not.toHaveBeenCalled();
  });

  it("reports a card that is not there", async () => {
    mocks.scheduleFindOne.mockReturnValue(lean(null));

    await expect(
      deleteFeeSchedule(hostelId, currentId.toString(), principal),
    ).rejects.toMatchObject({ errorCode: "FEE_SCHEDULE_MISSING" });
  });
});

/**
 * Which card is "current" — the question the Finance screen got backwards in
 * both directions at once.
 *
 * The live shape that exposed it: September's rates sat on a card closed on
 * 1 October to make room for a successor, so it had an `effectiveTo` and read as
 * finished; the successor had no `effectiveTo` and read as active, but did not
 * start for another month. The owner was shown 18,000 as live while their
 * residents were invoiced at 180,000 from the card filed under history.
 */
describe("labelSchedules", () => {
  /** Bhadra's card: closed to make room for Aswin's, and still the live one. */
  const bhadra = {
    _id: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0e1"),
    effectiveFrom: bs(BHADRA, 15),
    effectiveTo: bs(ASWIN, 1),
  };
  /** Aswin's: open, and not yet pricing anybody. */
  const aswin = {
    _id: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0e2"),
    effectiveFrom: bs(ASWIN, 1),
    effectiveTo: null,
  };
  /** Shrawan's: finished before this month began. */
  const shrawan = {
    _id: new Types.ObjectId("64f0f0f0f0f0f0f0f0f0f0e3"),
    effectiveFrom: bs(SHRAWAN, 1),
    effectiveTo: bs(SHRAWAN, 31),
  };

  const standings = (now: Date) =>
    Object.fromEntries(
      labelSchedules([aswin, bhadra, shrawan], now).map((schedule) => [
        schedule._id.toString(),
        schedule.standing,
      ]),
    );

  it("calls a closed card current when it is the one billing this month", () => {
    // Closed at the start of Aswin, but on Bhadra 18 it is what residents pay.
    expect(standings(NOW)[bhadra._id.toString()]).toBe("current");
  });

  it("does not call an open card current before its month arrives", () => {
    expect(standings(NOW)[aswin._id.toString()]).toBe("upcoming");
  });

  it("calls a card that ended before this month past", () => {
    expect(standings(NOW)[shrawan._id.toString()]).toBe("past");
  });

  it("hands over on the first of the month the new card starts", () => {
    // 5 October 2026 is Aswin 19 — inside Aswin, a fortnight before the
    // Gregorian month the old arithmetic would have handed over on.
    const inAswin = standings(new Date("2026-10-05T04:00:00.000Z"));

    expect(inAswin[aswin._id.toString()]).toBe("current");
    expect(inAswin[bhadra._id.toString()]).toBe("past");
  });

  it("names exactly one card current", () => {
    // Two overlapping cards is the ambiguity the open-row index exists to
    // prevent; the label must not reintroduce it.
    const labelled = labelSchedules([aswin, bhadra, shrawan], NOW);

    expect(labelled.filter((schedule) => schedule.standing === "current")).toHaveLength(1);
  });

  it("names none current when nothing covers this month", () => {
    // A real and reportable state: rates booked for the future, nobody billable
    // now. The old screen could not show it at all.
    const labelled = labelSchedules([aswin], NOW);

    expect(labelled[0]!.standing).toBe("upcoming");
  });
});
