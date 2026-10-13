import * as XLSX from "xlsx";

import { addBsMonths } from "@/lib/hostel-day";

import {
  readBsMonth,
  readJoinedDate,
  readMonthsDue,
  readPhone,
  readRupees,
} from "./existing-residents-cells";

/**
 * The Excel file a hostel fills in with the people already living there
 * (docs/EXISTING_RESIDENTS.md, item 3).
 *
 * ## Written for the person holding the notebook
 *
 * The reader is forgiving about everything a person types differently from how
 * we would: `Asoj` or `Aswin` or `असोज`, `Rs 12,000` or `१२०००`, a header typed
 * as `Mobile` instead of `Phone`, a column moved. It is strict about only one
 * thing — it never guesses a value it cannot read. A cell it cannot read is left
 * empty and named in `notes`, so the list's own check step tells the hostel what
 * to fix instead of a wrong number quietly becoming a bill.
 *
 * ## No example row in the sheet
 *
 * An example on row 2 of the Residents sheet gets uploaded as a resident sooner
 * or later. The example lives on the "How to fill" sheet instead.
 */

export type ExistingResidentFileRow = {
  depositPaid: number;
  email: string;
  fullName: string;
  joinedDate: Date | null;
  monthlyRent: number | null;
  oldDues: number;
  paidTill: string | null;
  phone: string;
  roomNumber: string;
  roomType: string;
};

export type ExistingResidentFileResult = {
  /** Plain-English lines about cells that could not be read. */
  notes: string[];
  rows: ExistingResidentFileRow[];
};

export class ExistingResidentFileError extends Error {
  errorCode = "EXISTING_RESIDENTS_FILE_UNREADABLE";
  status = 422;
}

/**
 * `monthsDue` is how the file asks about rent — "how many months are not paid",
 * a number anybody holding the notebook can answer. `paidTill` is not in the
 * template but is still read, for a sheet somebody made with a month in it.
 */
type ColumnKey = keyof ExistingResidentFileRow | "monthsDue";

/** The header each column is written with, in the order it appears. */
export const EXISTING_RESIDENT_COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "fullName", label: "Full name" },
  { key: "phone", label: "Phone" },
  { key: "roomType", label: "Room type" },
  // Filled by a formula from the room type; read back, never used — rent is the rate card's.
  { key: "monthlyRent", label: "Monthly rent (Rs)" },
  { key: "depositPaid", label: "Deposit paid (Rs)" },
  { key: "monthsDue", label: "Months due" },
  { key: "oldDues", label: "Old dues (Rs)" },
  { key: "joinedDate", label: "Joined date" },
  { key: "email", label: "Email" },
];

/**
 * Written last, and only for a hostel that keeps floors and rooms — last, so a
 * sheet copied from the older template still pastes into the same columns.
 */
const ROOM_NUMBER_COLUMN: { key: ColumnKey; label: string } = { key: "roomNumber", label: "Room no." };

/** Columns read but not always written, in the same shape. */
const EXTRA_COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "paidTill", label: "Rent paid till" },
  ROOM_NUMBER_COLUMN,
];

/** Other ways people write the same header. Compared with letters only. */
const HEADER_ALIASES: Record<ColumnKey, string[]> = {
  depositPaid: ["depositpaid", "deposit", "securitydeposit", "depositamount"],
  email: ["email", "emailaddress", "mail"],
  fullName: ["fullname", "name", "residentname", "studentname"],
  joinedDate: ["joineddate", "joined", "joiningdate", "joindate", "moveindate", "admissiondate"],
  monthlyRent: ["monthlyrent", "rent", "monthlyfee", "fee", "rentamount"],
  monthsDue: ["monthsdue", "monthdue", "monthsnotpaid", "unpaidmonths", "duemonths", "monthsunpaid"],
  oldDues: ["olddues", "dues", "due", "dueamount", "remaining", "baki"],
  paidTill: ["rentpaidtill", "paidtill", "paiduntil", "rentpaidupto", "paidupto", "paidtillmonth"],
  phone: ["phone", "phonenumber", "mobile", "mobilenumber", "contact", "contactnumber"],
  roomNumber: ["roomno", "roomnumber", "roomnum", "roomnos"],
  roomType: ["roomtype", "room", "roomcategory"],
};

const MAX_ROWS = 500;
const MAX_BYTES = 2 * 1024 * 1024;

function headerKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .replace(/[^a-z]/g, "");
}

function columnFor(header: string): ColumnKey | null {
  const key = headerKey(header);

  if (!key) {
    return null;
  }

  for (const column of [...EXISTING_RESIDENT_COLUMNS, ...EXTRA_COLUMNS]) {
    if (HEADER_ALIASES[column.key].includes(key)) {
      return column.key;
    }
  }

  return null;
}

export {
  readBsMonth,
  readJoinedDate,
  readMonthsDue,
  readPhone,
  readRupees,
  westernDigits,
} from "./existing-residents-cells";

/* ── Reading a file ─────────────────────────────────────────────────────── */

function gridFromBytes(bytes: Buffer): string[][] {
  let book: XLSX.WorkBook;

  try {
    book = XLSX.read(bytes, {
      cellDates: false,
      cellFormula: false,
      cellHTML: false,
      codepage: 65001,
      dateNF: "yyyy-mm-dd",
      raw: false,
      type: "buffer",
    });
  } catch {
    throw new ExistingResidentFileError(
      "This file could not be opened. Upload the Excel file you downloaded, or a CSV file.",
    );
  }

  // The sheet with the header on it, not simply the first — a filled template
  // may have had "How to fill" dragged to the front.
  for (const name of book.SheetNames) {
    const sheet = book.Sheets[name];

    if (!sheet) continue;

    // Blank rows kept, so a grid index + 1 is the line number Excel shows.
    const grid = XLSX.utils.sheet_to_json<string[]>(sheet, {
      blankrows: true,
      defval: "",
      header: 1,
      raw: false,
    });

    if (grid.slice(0, 10).some((row) => headerRowColumns(row).size >= 2)) {
      return grid.map((row) => (row ?? []).map((cell) => String(cell ?? "")));
    }
  }

  throw new ExistingResidentFileError(
    'We could not find the "Full name" and "Phone" columns. Use the Excel file you downloaded and keep its first row.',
  );
}

function headerRowColumns(row: unknown[] | undefined): Map<number, ColumnKey> {
  const columns = new Map<number, ColumnKey>();

  (row ?? []).forEach((cell, index) => {
    const key = columnFor(String(cell ?? ""));

    if (key && ![...columns.values()].includes(key)) {
      columns.set(index, key);
    }
  });

  return columns;
}

/**
 * `currentPeriod` turns "2 months due" into the month the rent is paid till,
 * **at the moment the file is read** — so a list filled on Aswin 30 and added on
 * Kartik 2 still knows Aswin was the month that was due, and bills Kartik too.
 */
export function readExistingResidentsFile(
  bytes: Buffer,
  currentPeriod: string,
): ExistingResidentFileResult {
  if (bytes.length === 0) {
    throw new ExistingResidentFileError("This file is empty.");
  }

  if (bytes.length > MAX_BYTES) {
    throw new ExistingResidentFileError("This file is too big. Keep it under 2 MB.");
  }

  const grid = gridFromBytes(bytes);
  const headerIndex = grid.findIndex((row, index) => index < 10 && headerRowColumns(row).size >= 2);
  const columns = headerRowColumns(grid[headerIndex]);
  const found = new Set(columns.values());

  if (!found.has("fullName") || !found.has("phone")) {
    throw new ExistingResidentFileError(
      'The file needs a "Full name" column and a "Phone" column in its first row.',
    );
  }

  const notes: string[] = [];
  const rows: ExistingResidentFileRow[] = [];

  for (let index = headerIndex + 1; index < grid.length; index += 1) {
    const cells = grid[index] ?? [];
    const lineNumber = index + 1;
    const value = (key: ColumnKey) => {
      for (const [column, columnKey] of columns) {
        if (columnKey === key) return String(cells[column] ?? "").trim();
      }

      return "";
    };

    if ([...columns.keys()].every((column) => !String(cells[column] ?? "").trim())) {
      continue;
    }

    if (rows.length >= MAX_ROWS) {
      notes.push(`Only the first ${MAX_ROWS} residents were read. Upload the rest in a second file.`);
      break;
    }

    const cannotRead = (label: string, text: string) =>
      notes.push(`Line ${lineNumber}: could not read ${label} "${text}".`);

    const deposit = readRupees(value("depositPaid"));
    const dues = readRupees(value("oldDues"));
    const monthsDue = readMonthsDue(value("monthsDue"));
    const paidTillText = readBsMonth(value("paidTill"));
    const paidTill =
      typeof monthsDue === "number" ? addBsMonths(currentPeriod, -monthsDue) : paidTillText;
    const joined = readJoinedDate(value("joinedDate"));

    if (deposit === undefined) cannotRead("Deposit paid", value("depositPaid"));
    if (dues === undefined) cannotRead("Old dues", value("oldDues"));
    if (monthsDue === undefined) cannotRead("Months due", value("monthsDue"));
    if (monthsDue === null && paidTillText === undefined) {
      cannotRead("Rent paid till", value("paidTill"));
    }
    if (joined === undefined) cannotRead("Joined date", value("joinedDate"));

    rows.push({
      depositPaid: deposit ?? 0,
      email: value("email").toLowerCase(),
      fullName: value("fullName").replace(/\s+/g, " "),
      joinedDate: joined ?? null,
      monthlyRent: null,
      oldDues: dues ?? 0,
      paidTill: typeof paidTill === "string" ? paidTill : null,
      phone: readPhone(value("phone")),
      roomNumber: value("roomNumber"),
      roomType: value("roomType"),
    });
  }

  if (rows.length === 0) {
    throw new ExistingResidentFileError("No residents were found in this file.");
  }

  return { notes, rows };
}

/* ── Writing the template ───────────────────────────────────────────────── */

export function buildExistingResidentsTemplate(input: {
  /** `Aswin 2083` — this month, named in the help. */
  currentMonth: string;
  hostelName: string;
  /** Room numbers, when the hostel keeps floors and rooms: adds the Room no. column. */
  roomNumbers?: string[] | null;
  roomTypes: { monthlyRent: number | null; roomType: string }[];
}): Buffer {
  const book = XLSX.utils.book_new();
  const withRooms = Boolean(input.roomNumbers?.length);
  const columns = [...EXISTING_RESIDENT_COLUMNS, ...(withRooms ? [ROOM_NUMBER_COLUMN] : [])];
  const exampleRooms = withRooms ? [input.roomNumbers![0], input.roomNumbers![1] ?? input.roomNumbers![0]] : [];

  const firstRoom = input.roomTypes[0];
  const helpRows: (number | string)[][] = [
    [`Residents already living in ${input.hostelName}`],
    [],
    ["Fill one line for each resident on the Residents sheet. Do not change the first line."],
    [],
    ["Column", "What to write", "Needed"],
    ["Full name", "First and last name", "Yes"],
    ["Phone", "Mobile number", "Yes"],
    ["Room type", "One of the room types below, written the same way", "Yes"],
    ["Monthly rent (Rs)", "Fills itself from the room type, from the rate card. Do not type in it", "Auto"],
    ["Deposit paid (Rs)", "Security deposit you are holding for them", "No"],
    [
      "Months due",
      `Months of rent not paid. 0 = ${input.currentMonth} is paid. 1 = only ${input.currentMonth} is not paid. 2 = this month and last month are not paid.`,
      "Yes",
    ],
    ["Old dues (Rs)", "Any other money they still owe you from before", "No"],
    [
      "Joined date",
      "Date they joined, like 2082-04-15 (Nepali date). Empty = the 1st of the month their rent is paid till",
      "No",
    ],
    ["Email", "Their email, if they use one", "No"],
    ...(withRooms
      ? [["Room no.", `Their room number, like ${input.roomNumbers![0]}. The room type can be left empty then`, "Yes"]]
      : []),
    [],
    ["Example"],
    columns.map((column) => column.label),
    ["Ram Thapa", "9841234567", firstRoom?.roomType ?? "Double", firstRoom?.monthlyRent ?? "", "10000", "1", "2500", "2082-04-15", "", ...exampleRooms.slice(0, 1)],
    ["Sita KC", "9801234567", firstRoom?.roomType ?? "Double", firstRoom?.monthlyRent ?? "", "10000", "0", "", "", "", ...exampleRooms.slice(1)],
    [],
    ["Room types in this hostel", "Monthly rent from the rate card (Rs)"],
  ];
  // 1-based Excel rows of the room list, which the rent column looks up.
  const roomsFrom = helpRows.length + 1;

  helpRows.push(
    ...input.roomTypes.map((room) => [room.roomType, room.monthlyRent ?? ""]),
    [],
    ["Paid in advance? Write 0, then change it in the list after you upload."],
  );

  const roomsTo = roomsFrom + input.roomTypes.length - 1;
  const residents = XLSX.utils.aoa_to_sheet([columns.map((column) => column.label)]);

  if (input.roomTypes.length) {
    // Excel works these out when it opens the file: SheetJS writes no cached values.
    for (let line = 2; line <= MAX_ROWS + 1; line += 1) {
      residents[`D${line}`] = {
        f: `IF($C${line}="","",IFERROR(VLOOKUP($C${line},'How to fill'!$A$${roomsFrom}:$B$${roomsTo},2,FALSE),""))`,
        t: "n",
      };
    }

    residents["!ref"] = `A1:${withRooms ? "J" : "I"}${MAX_ROWS + 1}`;
  }

  residents["!cols"] = [
    { wch: 26 },
    { wch: 15 },
    { wch: 18 },
    { wch: 18 },
    { wch: 18 },
    { wch: 16 },
    { wch: 15 },
    { wch: 14 },
    { wch: 28 },
    ...(withRooms ? [{ wch: 10 }] : []),
  ];

  const help = XLSX.utils.aoa_to_sheet(helpRows);

  help["!cols"] = [{ wch: 26 }, { wch: 60 }, { wch: 10 }];

  XLSX.utils.book_append_sheet(book, residents, "Residents");
  XLSX.utils.book_append_sheet(book, help, "How to fill");

  return XLSX.write(book, { bookType: "xlsx", type: "buffer" }) as Buffer;
}
