import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

import { formatHostelDateTime } from "@hostel/shared/calendar/bs";

import { exportCellText } from "@/lib/csv";

import type { ReportExport } from "@/modules/reports/report-export.service";

/**
 * A report export as a PDF — the same table the CSV carries, laid out to be read
 * rather than parsed.
 *
 * ## Why both formats exist
 *
 * A CSV is for a spreadsheet and a PDF is for a person. An owner sending last
 * month's collection to their accountant wants the first; an owner handing the
 * same figures to a bank, a landlord or a family member wants the second.
 *
 * ## Generic, because `ReportExport` already is
 *
 * Every export — the report routes and every list a screen downloads — is a
 * `{ columns, rows }` table by then. So this renders *a table*: one renderer,
 * run on the server for the report routes and in the browser for screen lists.
 *
 * ## The layout
 *
 * A green band with the platform, the title and its scope; a summary line with
 * when it was made and the period it covers; a table with a filled header row,
 * striped rows, columns sized to what they hold and numbers right-aligned; a
 * footer with page n of N. Landscape once a table is wider than six columns.
 *
 * ## Not `receipt-pdf.ts`
 *
 * That module builds **financial instruments** — a receipt and a resident's
 * statement — with anti-forgery furniture. A report is an aggregate with no such
 * standing and must not carry those marks.
 */

const PORTRAIT = { height: 841.89, width: 595.28 } as const;
const MARGIN = 36;
const ROW_HEIGHT = 20;
const BODY_SIZE = 8.5;
const HEAD_SIZE = 8;
const CELL_PAD = 6;
const FOOTER_SPACE = 30;

const BRAND = rgb(10 / 255, 138 / 255, 75 / 255);
const INK = rgb(0.09, 0.11, 0.1);
const MUTED = rgb(0.42, 0.45, 0.44);
const RULE = rgb(0.87, 0.89, 0.88);
const STRIPE = rgb(0.965, 0.975, 0.97);
const HEAD_FILL = rgb(0.91, 0.96, 0.93);
const WHITE = rgb(1, 1, 1);

/**
 * `pdf-lib`'s standard fonts are WinAnsi, which throws on anything outside it —
 * a Devanagari hostel name, an em dash, a rupee sign. Sanitising beats crashing
 * a download, and the same trade is documented in `receipt-pdf.ts`.
 */
export function sanitize(text: string): string {
  return text
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    // The middle dot of the one date format is in WinAnsi; keep it.
    .replace(/[^\x20-\x7E·]/g, "");
}

/** Clipped to its column with an ellipsis, so a shortened value is visibly shortened. */
function fit(text: string, width: number, font: PDFFont, size: number): string {
  if (font.widthOfTextAtSize(text, size) <= width) return text;

  let clipped = text;

  while (clipped.length > 1 && font.widthOfTextAtSize(`${clipped}...`, size) > width) {
    clipped = clipped.slice(0, -1);
  }

  return `${clipped}...`;
}

const NUMERIC = /^-?[\d,]+(\.\d+)?%?$/;

export type ReportPdfInput = {
  generatedAt: Date;
  /** "Last 6 months", "Everything" — what the rows cover. Optional. */
  period?: string;
  /** The hostel, or the platform. Blank when the caller spans several hostels. */
  scopeName: string;
  /** What the reader is looking at — "Collection", "Occupancy". */
  title: string;
} & Pick<ReportExport, "columns" | "rows">;

export async function renderReportPdf(input: ReportPdfInput): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  pdf.setTitle(sanitize(input.title));
  pdf.setProducer("HostelPalika");

  const size = input.columns.length > 6
    ? { height: PORTRAIT.width, width: PORTRAIT.height }
    : PORTRAIT;
  const usable = size.width - MARGIN * 2;

  const rows = input.rows.map((row) => input.columns.map((column) => sanitize(exportCellText(row[column.key]))));
  const heads = input.columns.map((column) => sanitize(column.label).toUpperCase());

  // A column is numeric when every filled cell is a number: those align right.
  const numeric = input.columns.map((_, index) => {
    const filled = rows.map((row) => row[index]).filter(Boolean);

    return filled.length > 0 && filled.every((cell) => NUMERIC.test(cell));
  });

  // Widths from what each column holds (header and a sample of rows), scaled to the page.
  const sample = rows.slice(0, 300);
  const natural = input.columns.map((_, index) => {
    const widest = Math.max(
      bold.widthOfTextAtSize(heads[index], HEAD_SIZE),
      ...sample.map((row) => regular.widthOfTextAtSize(row[index] ?? "", BODY_SIZE)),
    );

    return Math.min(Math.max(widest + CELL_PAD * 2, 44), 220);
  });
  const total = natural.reduce((sum, width) => sum + width, 0);
  const widths = natural.map((width) => (width / total) * usable);
  const xs = widths.map((_, index) => MARGIN + widths.slice(0, index).reduce((sum, width) => sum + width, 0));

  let page: PDFPage = pdf.addPage([size.width, size.height]);
  let cursor = size.height;

  const text = (value: string, x: number, y: number, font: PDFFont, fontSize: number, color = INK) =>
    page.drawText(value, { color, font, size: fontSize, x, y });

  const cell = (value: string, index: number, y: number, font: PDFFont, fontSize: number, color = INK) => {
    const room = widths[index] - CELL_PAD * 2;
    const shown = fit(value, room, font, fontSize);
    const x = numeric[index]
      ? xs[index] + widths[index] - CELL_PAD - font.widthOfTextAtSize(shown, fontSize)
      : xs[index] + CELL_PAD;

    text(shown, x, y, font, fontSize, color);
  };

  const drawTableHead = () => {
    page.drawRectangle({ color: HEAD_FILL, height: ROW_HEIGHT, width: usable, x: MARGIN, y: cursor - ROW_HEIGHT });
    heads.forEach((head, index) => cell(head, index, cursor - 13.5, bold, HEAD_SIZE, BRAND));
    cursor -= ROW_HEIGHT;
  };

  /* ---- First page: the band, the summary line ---- */
  const bandHeight = 74;

  page.drawRectangle({ color: BRAND, height: bandHeight, width: size.width, x: 0, y: size.height - bandHeight });
  text("HostelPalika", MARGIN, size.height - 26, bold, 10, WHITE);
  text(sanitize(input.title), MARGIN, size.height - 50, bold, 20, WHITE);

  if (input.scopeName) {
    const scope = fit(sanitize(input.scopeName), usable / 2, regular, 10);

    text(scope, size.width - MARGIN - regular.widthOfTextAtSize(scope, 10), size.height - 26, regular, 10, WHITE);
  }

  cursor = size.height - bandHeight - 22;

  const summary = [
    `Generated ${formatHostelDateTime(input.generatedAt)}`,
    input.period ? `Period: ${input.period}` : "",
    `${rows.length} ${rows.length === 1 ? "row" : "rows"}`,
  ]
    .filter(Boolean)
    .join("   |   ");

  text(sanitize(summary), MARGIN, cursor, regular, 9, MUTED);
  cursor -= 16;

  drawTableHead();

  if (rows.length === 0) {
    text("Nothing to report for this period.", MARGIN + CELL_PAD, cursor - 16, regular, 10, MUTED);
  }

  /* ---- Rows, paginated; nothing is dropped ---- */
  rows.forEach((row, rowIndex) => {
    if (cursor - ROW_HEIGHT < MARGIN + FOOTER_SPACE) {
      page = pdf.addPage([size.width, size.height]);
      cursor = size.height - MARGIN;
      text(sanitize(input.title), MARGIN, cursor - 4, bold, 11, INK);
      cursor -= 18;
      drawTableHead();
    }

    if (rowIndex % 2 === 1) {
      page.drawRectangle({ color: STRIPE, height: ROW_HEIGHT, width: usable, x: MARGIN, y: cursor - ROW_HEIGHT });
    }

    row.forEach((value, index) => cell(value, index, cursor - 13.5, regular, BODY_SIZE));
    page.drawLine({
      color: RULE,
      end: { x: MARGIN + usable, y: cursor - ROW_HEIGHT },
      start: { x: MARGIN, y: cursor - ROW_HEIGHT },
      thickness: 0.5,
    });
    cursor -= ROW_HEIGHT;
  });

  /* ---- Footer on every page, once the count is known ---- */
  const pages = pdf.getPages();

  pages.forEach((each, index) => {
    const label = `Page ${index + 1} of ${pages.length}`;

    each.drawLine({ color: RULE, end: { x: size.width - MARGIN, y: MARGIN + 12 }, start: { x: MARGIN, y: MARGIN + 12 }, thickness: 0.5 });
    each.drawText(sanitize(`HostelPalika · ${input.title}`), { color: MUTED, font: regular, size: 8, x: MARGIN, y: MARGIN });
    each.drawText(label, {
      color: MUTED,
      font: regular,
      size: 8,
      x: size.width - MARGIN - regular.widthOfTextAtSize(label, 8),
      y: MARGIN,
    });
  });

  return pdf.save();
}
