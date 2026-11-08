import { hostelDayParts } from "@hostel/shared/calendar/bs";
import { z } from "zod";

import { readJoinedDate } from "@/lib/residents/existing-residents-cells";
import { cleanCell, joinedDateText } from "@/lib/residents/existing-residents-sheet-model";

/**
 * The hostel registration track sheet (`/hostel-registration-track-sheet`):
 * every agreement Softmato signs with a hostel, one line each. Shared by the
 * browser sheet and the API, so the ref code a line shows before it is saved is
 * worked out exactly the way the server will hand it out.
 */

export const AGREEMENT_STATUSES = [
  { label: "Signed", value: "SIGNED" },
  { label: "Active", value: "ACTIVE" },
  { label: "Ended", value: "ENDED" },
] as const;

export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number]["value"];

export type AgreementRow = {
  /** A superadmin, or the team member who signed it. Everyone else only reads it. */
  canEdit: boolean;
  hostelName: string;
  id: string;
  location: string;
  notes: string;
  ownerName: string;
  phone: string;
  refCode: string;
  /** The team member who put the line on the sheet. */
  signedBy: string;
  /** The Nepal day it was signed, UTC midnight, as ISO. */
  signedOn: string;
  status: AgreementStatus;
};

export type TrackSheetView = {
  /** The number the next saved line gets, unless somebody saves first. */
  nextSequence: number;
  rows: AgreementRow[];
  /** The viewer's name — what a new line's "Signed by" will say once saved. */
  you: string;
};

/** `SMT/HP/2026/007` — the AD year in Nepal when the line is made, and its number in the one run. */
export function agreementRef(sequence: number, now = new Date()) {
  return `SMT/HP/${hostelDayParts(now).year}/${String(sequence).padStart(3, "0")}`;
}

const objectId = z.string().regex(/^[a-f\d]{24}$/i);
const text = (max: number) => z.string().trim().max(max).default("");

export const trackSheetSaveSchema = z.object({
  /** Saved lines deleted in the sheet. Their codes stay spent. */
  removed: z.array(objectId).max(500).default([]),
  /** Only the lines changed since the last save; a line without `id` is new. */
  rows: z
    .array(
      z.object({
        id: objectId.optional(),
        hostelName: z.string().trim().min(1, "Write the hostel name.").max(160),
        location: text(160),
        notes: text(500),
        ownerName: text(120),
        phone: text(24),
        signedOn: z.coerce.date(),
        status: z.enum(["SIGNED", "ACTIVE", "ENDED"]),
      }),
    )
    .max(500),
});

export type TrackSheetSave = z.infer<typeof trackSheetSaveSchema>;

/* ── The sheet in the browser ─────────────────────────────────────────────── */

export type LineColumn =
  | "hostelName"
  | "location"
  | "notes"
  | "ownerName"
  | "phone"
  | "refCode"
  | "signedBy"
  | "signedOn"
  | "status";

/** Every cell is text while it is typed; `signedOn` is a Nepali date, `2083-06-05`. */
export type SheetLine = {
  cells: Record<LineColumn, string>;
  id?: string;
  key: string;
  /** Somebody else's saved line: shown, never changed or deleted here. */
  readOnly?: boolean;
};

export type LineError = { column: LineColumn; key: string; message: string };

let keySeed = 0;

/** A new line starts signed today, in Nepal. */
export function blankLine(now = new Date()): SheetLine {
  keySeed += 1;

  return {
    cells: {
      hostelName: "",
      location: "",
      notes: "",
      ownerName: "",
      phone: "",
      refCode: "",
      signedBy: "",
      signedOn: joinedDateText(now.toISOString()),
      status: "SIGNED",
    },
    key: `line-${keySeed}`,
  };
}

export function lineFrom(row: AgreementRow): SheetLine {
  return {
    cells: {
      hostelName: row.hostelName,
      location: row.location,
      notes: row.notes,
      ownerName: row.ownerName,
      phone: row.phone,
      refCode: row.refCode,
      signedBy: row.signedBy,
      signedOn: joinedDateText(row.signedOn),
      status: row.status,
    },
    id: row.id,
    key: row.id,
    readOnly: !row.canEdit,
  };
}

/** The saved lines, with empty lines under them to type into. */
export function linesFrom(rows: AgreementRow[], spare = 20): SheetLine[] {
  return [...rows.map(lineFrom), ...Array.from({ length: spare }, () => blankLine())];
}

/** Nothing typed — the date and status a line starts with don't count. */
export function isBlankLine(line: SheetLine) {
  return (
    !line.id &&
    (["hostelName", "location", "ownerName", "phone", "notes"] as const).every(
      (column) => !line.cells[column].trim(),
    )
  );
}

export function cleanLineCell(column: LineColumn, value: string) {
  if (column === "phone") return cleanCell("phone", value);
  if (column === "signedOn") return cleanCell("joinedDate", value);
  // Cleared with Backspace, a status goes back to the one every line starts with.
  if (column === "status") return value || "SIGNED";

  return value;
}

/** The changed lines as the API takes them — or the cells nothing is saved past. */
export function readLines(lines: SheetLine[], changed: ReadonlySet<string>) {
  const errors: LineError[] = [];
  const rows: TrackSheetSave["rows"] = [];

  for (const line of lines) {
    if (!changed.has(line.key) || isBlankLine(line)) continue;

    const { cells, key } = line;
    const signedOn = readJoinedDate(cells.signedOn);

    if (!cells.hostelName.trim()) {
      errors.push({ column: "hostelName", key, message: "Write the hostel name." });
    }

    if (!signedOn) {
      errors.push({ column: "signedOn", key, message: "Write the Nepali date like 2083-06-05." });
    }

    rows.push({
      ...(line.id ? { id: line.id } : {}),
      hostelName: cells.hostelName.trim(),
      location: cells.location.trim(),
      notes: cells.notes.trim(),
      ownerName: cells.ownerName.trim(),
      phone: cells.phone.trim(),
      signedOn: signedOn ?? new Date(NaN),
      status: cells.status as AgreementStatus,
    });
  }

  return { errors, rows };
}

/* ── Who is on which line ────────────────────────────────────────────────── */

/** Where somebody's cursor is: a line's place (see `placesOf`), since `at` on the server's clock. */
export type Place = { at: number; line: string | null };

/**
 * Each line's place, the same on every screen: a saved line by its id, a new
 * one by its order under the saved ones (`new-0` is the first). New lines are
 * never shared until saved, so their order is the only thing two screens agree on.
 */
export function placesOf(lines: SheetLine[]) {
  const places = new Map<string, string>();
  let draft = 0;

  for (const line of lines) places.set(line.key, line.id ?? `new-${draft++}`);

  return places;
}

/**
 * Who has a line several people are on. Whoever got there first types in it;
 * everyone after them only reads it until they move off it or save. `mine`
 * counts only while I am on `place` myself.
 */
export function holdersOf(place: string, here: (Place & { name: string })[], mine: Place | null) {
  const myAt = mine?.line === place ? mine.at : Infinity;

  return here.filter((other) => other.at < myAt).map((other) => other.name);
}

/**
 * The codes new lines will get when saved: in sheet order, for every line with
 * something typed and for the empty ones in `showOn` — the cursor's, and those
 * a colleague is on. The server numbers them in the same order, so they match
 * unless a colleague saves first.
 */
export function withRefPreview(
  lines: SheetLine[],
  nextSequence: number,
  showOn: ReadonlySet<string>,
  now = new Date(),
) {
  let next = nextSequence;

  return lines.map((line) =>
    line.id || (isBlankLine(line) && !showOn.has(line.key))
      ? line
      : { ...line, cells: { ...line.cells, refCode: agreementRef(next++, now) } },
  );
}
