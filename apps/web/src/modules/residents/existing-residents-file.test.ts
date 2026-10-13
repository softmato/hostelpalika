import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import { fromBs } from "@/lib/hostel-day";
import {
  buildExistingResidentsTemplate,
  ExistingResidentFileError,
  readBsMonth,
  readExistingResidentsFile,
  readJoinedDate,
  readMonthsDue,
  readPhone,
  readRupees,
} from "@/modules/residents/existing-residents-file";

function xlsxOf(rows: string[][], sheetName = "Residents"): Buffer {
  const book = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheetName);

  return XLSX.write(book, { bookType: "xlsx", type: "buffer" }) as Buffer;
}

describe("reading a month the way people write it", () => {
  it.each([
    ["Bhadra 2083", "2083-05"],
    ["bhadra 2083", "2083-05"],
    ["2083 Bhadra", "2083-05"],
    ["Asoj 2083", "2083-06"],
    ["Aswin, 2083", "2083-06"],
    ["Saun 2083", "2083-04"],
    ["भदौ २०८३", "2083-05"],
    ["चैत्र 2082", "2082-12"],
    ["2083-05", "2083-05"],
    ["2083/5", "2083-05"],
    ["2083-05-01", "2083-05"],
    ["Bhadra 83", "2083-05"],
  ])("%s → %s", (text, key) => {
    expect(readBsMonth(text)).toBe(key);
  });

  it("says empty is not given, and refuses what it cannot read", () => {
    expect(readBsMonth("")).toBeNull();
    expect(readBsMonth("September 2026")).toBeUndefined();
    expect(readBsMonth("2026-09")).toBeUndefined();
    expect(readBsMonth("2083-13")).toBeUndefined();
    expect(readBsMonth("paid")).toBeUndefined();
  });
});

describe("reading months due", () => {
  it("reads a count, and refuses words", () => {
    expect(readMonthsDue("0")).toBe(0);
    expect(readMonthsDue("२")).toBe(2);
    expect(readMonthsDue("3.0")).toBe(3);
    expect(readMonthsDue("")).toBeNull();
    expect(readMonthsDue("two")).toBeUndefined();
    expect(readMonthsDue("-1")).toBeUndefined();
  });
});

describe("reading money", () => {
  it("reads rupees however they are written", () => {
    expect(readRupees("12000")).toBe(12000);
    expect(readRupees("Rs 12,000")).toBe(12000);
    expect(readRupees("रु. १२,०००")).toBe(12000);
    expect(readRupees("12000.00")).toBe(12000);
    expect(readRupees(" ")).toBeNull();
  });

  it("refuses words and negative numbers instead of guessing", () => {
    expect(readRupees("twelve thousand")).toBeUndefined();
    expect(readRupees("-500")).toBeUndefined();
  });
});

describe("reading dates and phones", () => {
  it("reads a Nepali date by its year, and an English one by its year", () => {
    expect(readJoinedDate("2082-04-15")).toEqual(fromBs({ day: 15, month: 4, year: 2082 }));
    expect(readJoinedDate("2025-08-01")).toEqual(new Date(Date.UTC(2025, 7, 1)));
    expect(readJoinedDate("")).toBeNull();
    expect(readJoinedDate("last year")).toBeUndefined();
  });

  it("keeps only the digits of a phone", () => {
    expect(readPhone("984-123 4567")).toBe("9841234567");
    expect(readPhone("९८४१२३४५६७")).toBe("9841234567");
    expect(readPhone("+977 9841234567")).toBe("+9779841234567");
    expect(readPhone("9841234567.0")).toBe("9841234567");
  });
});

describe("reading a filled file", () => {
  it("reads the downloaded template back, row for row", () => {
    const template = buildExistingResidentsTemplate({
      currentMonth: "Aswin 2083",
      hostelName: "Education Light",
      roomTypes: [{ monthlyRent: 12000, roomType: "Double" }],
    });

    const book = XLSX.read(template, { type: "buffer" });
    const sheet = book.Sheets.Residents!;

    XLSX.utils.sheet_add_aoa(
      sheet,
      [
        ["Ram Thapa", "9841234567", "Double", "12000", "10000", "1", "2500", "2082-04-15", "RAM@example.com"],
        ["Sita KC", "9801234567", "Double", "11000", "", "0", "", "", ""],
      ],
      { origin: "A2" },
    );

    // Aswin 2083 is this month: 1 month due means paid till Bhadra.
    const result = readExistingResidentsFile(
      XLSX.write(book, { bookType: "xlsx", type: "buffer" }) as Buffer,
      "2083-06",
    );

    expect(result.notes).toEqual([]);
    expect(result.rows).toEqual([
      {
        depositPaid: 10000,
        email: "ram@example.com",
        fullName: "Ram Thapa",
        joinedDate: fromBs({ day: 15, month: 4, year: 2082 }),
        monthlyRent: null,
        oldDues: 2500,
        paidTill: "2083-05",
        phone: "9841234567",
        roomNumber: "",
        roomType: "Double",
      },
      {
        depositPaid: 0,
        email: "",
        fullName: "Sita KC",
        joinedDate: null,
        monthlyRent: null,
        oldDues: 0,
        paidTill: "2083-06",
        phone: "9801234567",
        roomNumber: "",
        roomType: "Double",
      },
    ]);
  });

  it("fills Monthly rent from the room type, looked up in the room list", () => {
    const template = buildExistingResidentsTemplate({
      currentMonth: "Aswin 2083",
      hostelName: "Education Light",
      roomTypes: [
        { monthlyRent: 12000, roomType: "Double" },
        { monthlyRent: 16000, roomType: "Single Room" },
      ],
    });
    const book = XLSX.read(template, { cellFormula: true, type: "buffer" });
    const formula = book.Sheets.Residents!.D2!.f!;
    const [, from, to] = /\$A\$(\d+):\$B\$(\d+)/.exec(formula)!;
    const help = book.Sheets["How to fill"]!;

    expect(formula).toContain("VLOOKUP($C2,'How to fill'!");
    expect(book.Sheets.Residents!.D501!.f).toContain("$C501");
    expect([help[`A${from}`]!.v, help[`B${from}`]!.v]).toEqual(["Double", 12000]);
    expect([help[`A${to}`]!.v, help[`B${to}`]!.v]).toEqual(["Single Room", 16000]);
    // The formulas alone are not a resident.
    expect(() => readExistingResidentsFile(template, "2083-06")).toThrow("No residents were found");
  });

  it("does not read the example on the How to fill sheet as a resident", () => {
    const template = buildExistingResidentsTemplate({
      currentMonth: "Aswin 2083",
      hostelName: "Education Light",
      roomTypes: [],
    });

    expect(() => readExistingResidentsFile(template, "2083-06")).toThrow("No residents were found");
  });

  it("accepts a CSV with headers written differently and columns moved", () => {
    const csv = Buffer.from(
      "Mobile,Name,Rent,Paid till,Room\n9841234567,Hari Shrestha,Rs 9000,Shrawan 2083,Single\n,,,,\n",
      "utf8",
    );

    const result = readExistingResidentsFile(csv, "2083-06");

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      fullName: "Hari Shrestha",
      monthlyRent: null,
      paidTill: "2083-04",
      phone: "9841234567",
      roomType: "Single",
    });
  });

  it("reads a months-due column written by hand, counting back from this month", () => {
    const file = xlsxOf([
      ["Name", "Mobile", "Months not paid"],
      ["Hari Shrestha", "9841234567", "3"],
    ]);

    expect(readExistingResidentsFile(file, "2083-06").rows[0]!.paidTill).toBe("2083-03");
  });

  it("names a cell it cannot read by its Excel line, and leaves it empty", () => {
    const file = xlsxOf([
      ["Full name", "Phone", "Rent paid till", "Monthly rent (Rs)"],
      ["Ram Thapa", "9841234567", "last month", "twelve"],
    ]);

    const result = readExistingResidentsFile(file, "2083-06");

    expect(result.rows[0]).toMatchObject({ monthlyRent: null, paidTill: null });
    expect(result.notes).toEqual(['Line 2: could not read Rent paid till "last month".']);
  });

  it("refuses a file with no name and phone columns", () => {
    const file = xlsxOf([["Room", "Rent"], ["Double", "12000"]]);

    expect(() => readExistingResidentsFile(file, "2083-06")).toThrow(ExistingResidentFileError);
  });

  it("reads rows pasted from a sheet — tab-separated text, as the panel sends it", () => {
    const pasted = Buffer.from(
      [
        "Full name\tPhone\tRoom type\tMonthly rent (Rs)\tDeposit paid (Rs)\tMonths due\tOld dues (Rs)\tJoined date\tEmail",
        "Ram Thapa\t9841234567\tDouble\t\t10,000\t1\t2500\t2082-04-15\tram@example.com",
        "सीता केसी\t9801234567\tDouble\t11000\t\t0\t\t\t",
      ].join("\r\n"),
      "utf8",
    );

    const result = readExistingResidentsFile(pasted, "2083-06");

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      depositPaid: 10000,
      email: "ram@example.com",
      fullName: "Ram Thapa",
      oldDues: 2500,
      paidTill: "2083-05",
      phone: "9841234567",
    });
    expect(result.rows[1]).toMatchObject({ fullName: "सीता केसी", monthlyRent: null, paidTill: "2083-06" });
  });
});
