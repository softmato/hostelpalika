import { describe, expect, it } from "vitest";

import type { ExistingCheck, ExistingRow } from "@/lib/existing-residents-api";
import {
  listTotals,
  monthName,
  rentStatusLabel,
  rentStatusOptions,
  rowSubtitle,
  rupeesFrom,
  sectionsFor,
} from "@/lib/existing-residents";

function row(overrides: Partial<ExistingRow> = {}): ExistingRow {
  return {
    depositPaid: 0,
    email: "",
    fullName: "Ram Thapa",
    id: "r1",
    joinedDate: null,
    monthlyRent: null,
    oldDues: 0,
    paidTill: "2083-06",
    phone: "9841234567",
    residentId: null,
    roomNumber: "",
    roomType: "Double",
    ...overrides,
  };
}

describe("existing residents on the phone", () => {
  it("asks paid this month or how many months due, and stores the month paid till", () => {
    const options = rentStatusOptions("2083-06");

    expect(options[0]).toEqual({
      description: "Nothing is billed now",
      label: "Paid this month",
      value: "2083-06",
    });
    expect(options[1]).toMatchObject({ description: "Aswin is billed", label: "1 month due", value: "2083-05" });
    expect(options[2]).toMatchObject({
      description: "Bhadra to Aswin are billed",
      label: "2 months due",
      value: "2083-04",
    });
    expect(options[12]).toMatchObject({ label: "12 months due", value: "2082-06" });
    expect(options[13]).toMatchObject({ label: "Paid ahead till Kartik", value: "2083-07" });
    expect(options).toHaveLength(15);
  });

  it("keeps a month from an uploaded file that the picker would not offer", () => {
    expect(rentStatusOptions("2083-06", "2081-01").at(-1)).toEqual({
      label: "Paid till Baisakh 2081",
      value: "2081-01",
    });
  });

  it("names the rent status on a row", () => {
    expect(rentStatusLabel("2083-06", "2083-06")).toBe("Paid this month");
    expect(rentStatusLabel("2083-04", "2083-06")).toBe("2 months due");
    expect(rentStatusLabel(null, "2083-06")).toBe("Rent not set");
  });

  it("names a month without the era", () => {
    expect(monthName("2083-05")).toBe("Bhadra 2083");
    expect(monthName(null)).toBe("");
  });

  it("reads rupees from whatever was typed", () => {
    expect(rupeesFrom("12,000")).toBe(12000);
    expect(rupeesFrom("")).toBeNull();
  });

  it("groups by room type with the rows to fix first and added rows last", () => {
    const check: ExistingCheck = {
      listProblems: [],
      ready: false,
      roomTypes: [],
      rows: [
        { added: false, bills: null, id: "a", problems: [], rent: 12000 },
        { added: false, bills: null, id: "b", problems: [{ field: "phone", message: "Write the phone number." }], rent: 12000 },
        { added: true, bills: null, id: "c", problems: [], rent: null },
      ],
      toAdd: 2,
      withProblems: 1,
    };

    const sections = sectionsFor(
      [
        row({ id: "c", residentId: "x" }),
        row({ id: "a" }),
        row({ id: "b", phone: "" }),
        row({ id: "d", roomType: "" }),
      ],
      check,
    );

    expect(sections.map((section) => section.title)).toEqual(["Double", "No room type yet"]);
    expect(sections[0]!.rows.map((entry) => entry.row.id)).toEqual(["b", "a", "c"]);
    expect(rowSubtitle(sections[0]!.rows[0]!.row, sections[0]!.rows[0]!.checked, "2083-06")).toBe(
      "Write the phone number.",
    );
    expect(rowSubtitle(row(), null, "2083-06")).toBe("9841234567 · Paid this month");
  });

  it("totals what adding the list will bill", () => {
    expect(
      listTotals({
        listProblems: [],
        ready: true,
        roomTypes: [],
        rows: [
          {
            added: false,
            bills: { months: [{ amount: 12000, label: "Aswin 2083", period: "2083-06" }], oldDues: 2500, total: 14500 },
            id: "a",
            problems: [],
            rent: 12000,
          },
        ],
        toAdd: 1,
        withProblems: 0,
      }),
    ).toEqual({ amount: 14500, dues: 1, months: 1 });
  });
});
