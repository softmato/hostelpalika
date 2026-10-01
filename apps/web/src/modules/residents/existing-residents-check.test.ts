import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ connectToDatabase: vi.fn() }));

import { fromBs } from "@/lib/hostel-day";
import {
  type CheckContext,
  checkExistingResidents,
  type ListRow,
  splitFullName,
  unpaidMonths,
} from "@/modules/residents/existing-residents-check";

/** Aswin 2083 is "this month" in every case below. */
const ASWIN = "2083-06";

function row(overrides: Partial<ListRow> = {}): ListRow {
  return {
    depositPaid: 10000,
    email: "",
    fullName: "Ram Thapa",
    id: "r1",
    joinedDate: null,
    monthlyRent: null,
    oldDues: 0,
    partPaid: 0,
    paidTill: ASWIN,
    phone: "9841234567",
    residentId: null,
    roomType: "Double",
    ...overrides,
  };
}

function context(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    currentPeriod: ASWIN,
    livingElsewhere: new Map(),
    roomTypes: [
      { monthlyRent: 12000, roomType: "Double", vacantBeds: 5 },
      { monthlyRent: null, roomType: "Single", vacantBeds: 1 },
    ],
    takenEmails: new Map(),
    takenPhones: new Map(),
    ...overrides,
  };
}

const messages = (result: ReturnType<typeof checkExistingResidents>, index = 0) =>
  result.rows[index]!.problems.map((problem) => problem.message);

describe("a clean list", () => {
  it("is ready, and bills nothing for a resident paid up to this month", () => {
    const result = checkExistingResidents([row()], context());

    expect(result.ready).toBe(true);
    expect(result.toAdd).toBe(1);
    expect(result.rows[0]!.bills).toEqual({ months: [], oldDues: 0, partPaid: 0, total: 0 });
    expect(result.rows[0]!.rent).toBe(12000);
  });

  it("shows the unpaid months and old dues that will be billed", () => {
    const result = checkExistingResidents(
      [row({ oldDues: 2500, paidTill: "2083-04" })],
      context(),
    );

    expect(result.rows[0]!.bills).toEqual({
      months: [
        { amount: 12000, label: "Bhadra 2083", period: "2083-05" },
        { amount: 12000, label: "Aswin 2083", period: "2083-06" },
      ],
      oldDues: 2500,
      partPaid: 0,
      total: 26500,
    });
  });

  it("takes a part payment off what is due", () => {
    const result = checkExistingResidents([row({ paidTill: "2083-05", partPaid: 3000 })], context());

    expect(result.ready).toBe(true);
    expect(result.rows[0]!.bills!.total).toBe(9000);
  });

  it("charges only the days after a joined date inside an unpaid month", () => {
    // Joined Aswin 16, paid nothing: Aswin is part of a month, not a whole one.
    const joined = fromBs({ day: 16, month: 6, year: 2083 }).toISOString();
    const result = checkExistingResidents(
      [row({ joinedDate: joined, paidTill: "2083-05" })],
      context(),
    );

    const aswin = result.rows[0]!.bills!.months[0]!;

    expect(aswin.period).toBe(ASWIN);
    expect(aswin.amount).toBeLessThan(12000);
    expect(aswin.amount).toBeGreaterThan(0);
  });

  it("bills the rate card's rent, whatever the line says", () => {
    const result = checkExistingResidents([row({ monthlyRent: 9000, paidTill: "2083-05" })], context());

    expect(result.rows[0]!.rent).toBe(12000);
    expect(result.rows[0]!.bills!.total).toBe(12000);
  });

  it("skips rows already added", () => {
    const result = checkExistingResidents([row({ fullName: "", residentId: "abc" })], context());

    expect(result.rows[0]).toMatchObject({ added: true, problems: [] });
    expect(result.toAdd).toBe(0);
    expect(result.ready).toBe(false);
  });
});

describe("problems, in plain words", () => {
  it("asks for the things that are needed", () => {
    const result = checkExistingResidents(
      [row({ fullName: "", paidTill: null, phone: "", roomType: "" })],
      context(),
    );

    expect(messages(result)).toEqual([
      "Write the full name.",
      "Write the phone number.",
      "Choose a room type.",
      "Choose if this month's rent is paid, or how many months are due.",
    ]);
    expect(result.ready).toBe(false);
  });

  it("asks for a last name and a real phone", () => {
    const result = checkExistingResidents([row({ fullName: "Ram", phone: "98412" })], context());

    expect(messages(result)).toEqual([
      "Write first and last name.",
      "This phone number looks wrong.",
    ]);
  });

  it("names the line a duplicate phone or email is on", () => {
    const result = checkExistingResidents(
      [
        row({ email: "ram@example.com" }),
        row({ email: "RAM@example.com", fullName: "Hari Thapa", id: "r2" }),
      ],
      context(),
    );

    expect(messages(result, 1)).toEqual([
      "Same phone as line 1.",
      "Same email as line 1.",
    ]);
  });

  it("says who in the hostel already has the phone or email", () => {
    const result = checkExistingResidents(
      [row({ email: "sita@example.com" })],
      context({
        takenEmails: new Map([["sita@example.com", "Sita KC"]]),
        takenPhones: new Map([["9841234567", "Sita KC"]]),
      }),
    );

    expect(messages(result)).toEqual([
      "Sita KC already uses this phone in this hostel.",
      "Sita KC already uses this email in this hostel.",
    ]);
  });

  it("refuses someone still living in another hostel", () => {
    const result = checkExistingResidents(
      [row({ email: "ram@example.com" })],
      context({ livingElsewhere: new Map([["ram@example.com", "Everest Boys Hostel"]]) }),
    );

    expect(messages(result)).toEqual([
      "This person is already living in Everest Boys Hostel. They must move out there first.",
    ]);
  });

  it("names a room type the hostel does not have, and matches case loosely", () => {
    const result = checkExistingResidents(
      [row({ roomType: "Triple" }), row({ id: "r2", phone: "9801234567", roomType: "double" })],
      context(),
    );

    expect(messages(result, 0)).toEqual(['"Triple" is not a room type in this hostel.']);
    expect(messages(result, 1)).toEqual([]);
  });

  it("asks for a rent when the room has none", () => {
    const result = checkExistingResidents([row({ roomType: "Single" })], context());

    expect(messages(result)).toEqual([
      "Single has no rent in the rate card. Set it in Fee schedule first.",
    ]);
  });

  it("keeps Rent paid till within a year either way", () => {
    const result = checkExistingResidents(
      [
        row({ paidTill: "2082-05" }),
        row({ id: "r2", paidTill: "2084-07", phone: "9801234567" }),
      ],
      context(),
    );

    expect(messages(result, 0)).toEqual(["More than 12 months due. Put the older money in Old dues."]);
    expect(messages(result, 1)).toEqual(["Paid more than 12 months ahead. Check the month."]);
  });

  it("keeps part paid below the first month due, and only when one is due", () => {
    const paid = checkExistingResidents([row({ partPaid: 1000 })], context());
    const whole = checkExistingResidents([row({ paidTill: "2083-05", partPaid: 12000 })], context());

    expect(paid.rows[0]!.problems).toEqual([
      { field: "partPaid", message: "Nothing is due, so nothing can be part paid." },
    ]);
    expect(whole.rows[0]!.problems[0]!.field).toBe("partPaid");
    expect(whole.ready).toBe(false);
  });

  it("refuses a joined date in the future", () => {
    const later = fromBs({ day: 1, month: 8, year: 2083 }).toISOString();
    const result = checkExistingResidents([row({ joinedDate: later })], context());

    expect(messages(result)).toEqual(["Joined date cannot be in the future."]);
  });

  it("stops the list when a room type has more residents than free beds", () => {
    const result = checkExistingResidents(
      [
        row({ monthlyRent: 15000, roomType: "Single" }),
        row({ id: "r2", monthlyRent: 15000, phone: "9801234567", roomType: "Single" }),
      ],
      context(),
    );

    expect(result.listProblems).toEqual([
      "Single has 1 free bed but 2 residents in this list. Change the beds in Rooms first.",
    ]);
    expect(result.ready).toBe(false);
    expect(result.roomTypes).toEqual([{ freeBeds: 1, inList: 2, roomType: "Single" }]);
  });
});

describe("helpers", () => {
  it("splits a name on its last word", () => {
    expect(splitFullName("Ram Bahadur Thapa")).toEqual({ firstName: "Ram Bahadur", lastName: "Thapa" });
    expect(splitFullName("Ram")).toBeNull();
  });

  it("lists the months after Rent paid till, across the new year", () => {
    expect(unpaidMonths("2082-11", "2083-01")).toEqual(["2082-12", "2083-01"]);
    expect(unpaidMonths("2083-06", "2083-06")).toEqual([]);
  });
});
