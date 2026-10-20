/**
 * CSV serialisation for report exports (PHASES.md §5.1).
 *
 * Two things matter here beyond joining commas:
 *
 * 1. **Quoting.** Any value carrying a comma, quote, newline or leading space
 *    is quoted and its quotes doubled, per RFC 4180.
 * 2. **Formula injection.** A cell starting with `=`, `+`, `-`, `@`, tab or CR
 *    is executed by Excel and Google Sheets when the file is opened. Hostel
 *    names and complaint titles are user-supplied, so every such cell gets a
 *    leading apostrophe — the spreadsheet then shows the text and runs nothing.
 */

import { formatHostelDate } from "@hostel/shared/calendar/bs";

const FORMULA_TRIGGERS = ["=", "+", "-", "@", "\t", "\r"];

/** An ISO instant as an API row carries it — `2026-10-20T09:15:00.000Z`. */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/**
 * A date cell in the platform's one format (`Baisakh · 2083-01-15`), whether the
 * row holds a `Date` or the ISO string an API returned. Everything else as is.
 */
export function exportCellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return formatHostelDate(value, "");
  if (typeof value === "string" && ISO_INSTANT.test(value)) return formatHostelDate(value, value);

  return String(value);
}

function neutralize(value: string) {
  return FORMULA_TRIGGERS.some((trigger) => value.startsWith(trigger))
    ? `'${value}`
    : value;
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }

  const raw = exportCellText(value);

  // Numbers and booleans are ours, not the user's — never mangle them.
  const safe = typeof value === "string" ? neutralize(raw) : raw;

  return /[",\n\r]|^\s|\s$/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function toCsv(
  columns: Array<{ key: string; label: string }>,
  rows: Array<Record<string, unknown>>,
) {
  const header = columns.map((column) => csvCell(column.label)).join(",");
  const body = rows.map((row) =>
    columns.map((column) => csvCell(row[column.key])).join(","),
  );

  // CRLF is what Excel expects; a trailing newline keeps `wc -l` honest.
  return [header, ...body].join("\r\n") + "\r\n";
}

/** Content-Disposition-safe filename: `questioncall-2026-08-01.csv`. */
export function csvFilename(prefix: string, date = new Date()) {
  return `${prefix}-${date.toISOString().slice(0, 10)}.csv`;
}

export function csvResponse(body: string, filename: string) {
  return new Response(body, {
    headers: {
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="${filename}"`,
      "content-type": "text/csv; charset=utf-8",
    },
    status: 200,
  });
}
