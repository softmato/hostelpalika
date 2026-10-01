import { addBsMonths, BS_MONTHS, formatBsPeriod, isBsPeriod, toBs } from "@hostel/shared/calendar/bs";

import {
  readBsMonth,
  readJoinedDate,
  readMonthsDue,
  readRupees,
  westernDigits,
} from "./existing-residents-cells";
import type { ListRow, RowField } from "./existing-residents-check";

/**
 * The browser sheet behind "Fill in sheet" (docs/EXISTING_RESIDENTS.md) — for the
 * warden whose Excel won't type. Every cell is text while it is being typed, the
 * way a spreadsheet holds it; reading the sheet back uses the same cell readers
 * as an uploaded file, so a pasted "10,000" or "२०८२-०४-१५" means what it means
 * in the file.
 */

export const SHEET_COLUMNS = [
  { key: "fullName", label: "Full name", width: 200 },
  { key: "phone", label: "Phone", width: 130 },
  { key: "roomType", label: "Room type", width: 150 },
  { key: "monthlyRent", label: "Monthly rent (Rs)", width: 140 },
  { key: "depositPaid", label: "Deposit paid (Rs)", width: 140 },
  { key: "paidTill", label: "Rent", width: 230 },
  { key: "oldDues", label: "Old dues (Rs)", width: 120 },
  { key: "joinedDate", label: "Joined date (Nepali)", width: 160 },
  { key: "email", label: "Email", width: 230 },
] as const;

export type SheetColumn = (typeof SHEET_COLUMNS)[number]["key"];

export type SheetRow = {
  /** Text as typed. `paidTill` holds a month key (`2083-05`); `roomType` the room's name. */
  cells: Record<SheetColumn, string>;
  id?: string;
  key: string;
  residentId: string | null;
};

/** What the list API takes for one line. */
export type SheetOutRow = Omit<ListRow, "id" | "residentId"> & { id?: string };

export type CellError = { column: SheetColumn; key: string; message: string };

/** What the sheet fills in by itself: each room's rent from the rate card, and this month. */
export type SheetContext = {
  currentPeriod: string;
  rooms: { monthlyRent: number | null; roomType: string }[];
};

/** Filled by the system, never typed or pasted into. */
export const AUTO_COLUMNS: readonly SheetColumn[] = ["monthlyRent"];

let keySeed = 0;

function newKey() {
  keySeed += 1;

  return `sheet-${keySeed}`;
}

/** The joined date written when none is: see `defaultJoinedDate`, which the server uses. */
function defaultJoinedText(paidTill: string, currentPeriod: string) {
  if (!isBsPeriod(paidTill)) return "";

  return `${paidTill < currentPeriod ? paidTill : currentPeriod}-01`;
}

/**
 * The boxes the sheet fills itself, after `before` became `cells`: the rent is
 * the room's, and a joined date nobody typed follows the rent choice — so
 * changing "Paid this month" to "2 months due" never leaves a joined date that
 * bills the older month short.
 */
export function autoFill(
  cells: SheetRow["cells"],
  before: SheetRow["cells"],
  context: SheetContext,
): SheetRow["cells"] {
  const room = context.rooms.find(
    (candidate) => candidate.roomType.trim().toLowerCase() === cells.roomType.trim().toLowerCase(),
  );
  // Untouched by this change, and either empty or the date the sheet wrote itself.
  const joinedIsAuto =
    cells.joinedDate === before.joinedDate &&
    (!before.joinedDate.trim() || before.joinedDate === defaultJoinedText(before.paidTill, context.currentPeriod));

  return {
    ...cells,
    joinedDate: joinedIsAuto
      ? defaultJoinedText(cells.paidTill, context.currentPeriod) || cells.joinedDate
      : cells.joinedDate,
    monthlyRent: room?.monthlyRent ? String(room.monthlyRent) : "",
  };
}

/**
 * What a box accepts, applied as it is typed or pasted: amounts are digits only
 * ("10,000" → "10000"), a phone keeps a leading +, a date keeps its separators,
 * an email has no spaces. Nepali digits become Western ones.
 */
export function cleanCell(column: SheetColumn, value: string) {
  const digits = westernDigits(value);

  switch (column) {
    case "depositPaid":
    case "monthlyRent":
    case "oldDues":
      return digits.replace(/\.\d*$/, "").replace(/\D/g, "");
    case "phone":
      return digits.replace(/(?!^\+)\D/g, "");
    case "joinedDate":
      return digits.replace(/[^\d/.-]/g, "");
    case "email":
      return value.replace(/\s/g, "");
    default:
      return value;
  }
}

/** `2082-04-15` — the joined date as a Nepali date, which is how the hostel wrote it. */
export function joinedDateText(iso: string | null) {
  if (!iso) return "";

  const { day, month, year } = toBs(new Date(iso));

  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function blankSheetRow(): SheetRow {
  return {
    cells: {
      depositPaid: "0",
      email: "",
      fullName: "",
      joinedDate: "",
      monthlyRent: "",
      oldDues: "0",
      paidTill: "",
      phone: "",
      roomType: "",
    },
    key: newKey(),
    residentId: null,
  };
}

export function sheetRowFrom(row: ListRow, context: SheetContext): SheetRow {
  const cells = {
    depositPaid: String(row.depositPaid ?? 0),
    email: row.email,
    fullName: row.fullName,
    joinedDate: joinedDateText(row.joinedDate),
    monthlyRent: "",
    oldDues: String(row.oldDues ?? 0),
    paidTill: row.paidTill ?? "",
    phone: row.phone,
    roomType: row.roomType,
  };

  return {
    cells: autoFill(cells, cells, context),
    id: row.id,
    key: row.id,
    residentId: row.residentId,
  };
}

/** The list's lines, with empty lines under them to type into. */
export function sheetFrom(rows: ListRow[], context: SheetContext, spare = 20): SheetRow[] {
  return [...rows.map((row) => sheetRowFrom(row, context)), ...Array.from({ length: spare }, blankSheetRow)];
}

/** Nothing typed but the defaults — never saved, never checked. */
export function isBlankSheetRow(row: SheetRow) {
  return (
    !row.residentId &&
    Object.entries(row.cells).every(
      ([column, value]) =>
        !value.trim() ||
        AUTO_COLUMNS.includes(column as SheetColumn) ||
        ((column === "depositPaid" || column === "oldDues") && value.trim() === "0"),
    )
  );
}

/** The sheet as list lines — or the cells that can't be read, which nothing is saved past. */
export function readSheet(rows: SheetRow[]): { errors: CellError[]; rows: SheetOutRow[] } {
  const errors: CellError[] = [];
  const out: SheetOutRow[] = [];

  for (const row of rows) {
    if (isBlankSheetRow(row)) continue;

    const { cells } = row;
    const fail = (column: SheetColumn, message: string) => errors.push({ column, key: row.key, message });
    const amount = (column: "depositPaid" | "oldDues") => {
      const value = readRupees(cells[column]);

      if (value === undefined) fail(column, "Write only the amount, like 12000.");

      return value ?? null;
    };

    const joined = readJoinedDate(cells.joinedDate);

    if (joined === undefined) fail("joinedDate", "Write the Nepali date like 2082-04-15.");

    const paidTill = cells.paidTill.trim();

    if (paidTill && !isBsPeriod(paidTill)) fail("paidTill", "Choose from the list.");

    out.push({
      depositPaid: amount("depositPaid") ?? 0,
      email: cells.email.trim(),
      fullName: cells.fullName.trim(),
      ...(row.id ? { id: row.id } : {}),
      joinedDate: joined ? joined.toISOString() : null,
      // The rate card's, read by the server — the box only shows it.
      monthlyRent: null,
      oldDues: amount("oldDues") ?? 0,
      paidTill: paidTill || null,
      // No column for it: part paid is taken at the scan desk and on join requests.
      partPaid: 0,
      phone: cells.phone.trim(),
      roomType: cells.roomType.trim(),
    });
  }

  return { errors, rows: out };
}

/**
 * Rows copied from any spreadsheet, pasted with the cursor on one cell: they fill
 * rightwards and downwards from there, in the Excel file's column order, over
 * lines already added as residents rather than into them. A copied header line
 * is skipped. "Months due" pasted into Rent becomes the month rent is paid till.
 * A pasted rent is dropped: that box is the rate card's.
 */
export function pasteIntoSheet(
  rows: SheetRow[],
  at: { column: number; row: number },
  text: string,
  context: SheetContext,
): SheetRow[] {

  let lines = text.replace(/\r\n?/g, "\n").replace(/\n$/, "").split("\n");

  if (/name/i.test(lines[0] ?? "") && /phone/i.test(lines[0] ?? "")) {
    lines = lines.slice(1);
  }

  const next = [...rows];
  let target = at.row;

  for (const line of lines) {
    while (next[target]?.residentId) target += 1;

    while (target >= next.length) next.push(blankSheetRow());

    const row = next[target]!;
    const cells = { ...row.cells };

    line.split("\t").forEach((raw, offset) => {
      const column = SHEET_COLUMNS[at.column + offset]?.key;

      if (!column || AUTO_COLUMNS.includes(column)) return;

      const value = raw.trim();

      if (column === "roomType") {
        cells.roomType =
          context.rooms.find((room) => room.roomType.toLowerCase() === value.toLowerCase())?.roomType ??
          value;
      } else if (column === "paidTill") {
        const due = readMonthsDue(value);
        const month = typeof due === "number" ? null : readBsMonth(value);

        cells.paidTill =
          typeof due === "number" ? addBsMonths(context.currentPeriod, -due) : (month ?? value);
      } else {
        cells[column] = cleanCell(column, value);
      }
    });

    next[target] = { ...row, cells: autoFill(cells, row.cells, context) };
    target += 1;
  }

  return next;
}

/** "Is this month paid, or how many months are due?" — stored as the month rent is paid till. */
export function rentStatusOptions(currentPeriod: string, value: string | null) {
  const name = (period: string) => BS_MONTHS[Number(period.slice(5)) - 1] ?? period;
  const options = [{ label: "Paid this month", value: currentPeriod }];

  for (let due = 1; due <= 12; due += 1) {
    const from = addBsMonths(currentPeriod, 1 - due);

    options.push({
      label:
        due === 1
          ? `1 month due (${name(currentPeriod)})`
          : `${due} months due (${name(from)} to ${name(currentPeriod)})`,
      value: addBsMonths(currentPeriod, -due),
    });
  }

  for (let ahead = 1; ahead <= 2; ahead += 1) {
    const till = addBsMonths(currentPeriod, ahead);

    options.push({ label: `Paid ahead till ${name(till)}`, value: till });
  }

  if (value && !options.some((option) => option.value === value)) {
    options.push({ label: `Paid till ${formatBsPeriod(value) || value}`, value });
  }

  return options;
}

export function rentStatusLabel(currentPeriod: string, value: string | null) {
  if (!value) return null;

  return rentStatusOptions(currentPeriod, value).find((option) => option.value === value)?.label ?? null;
}

/** Which sheet column a checked problem belongs to — the names are the same. */
export function columnOfProblem(field: RowField): SheetColumn {
  return field === "partPaid" ? "paidTill" : field;
}
