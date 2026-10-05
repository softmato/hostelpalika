import { PDFDocument, rgb } from "pdf-lib";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import { formatBsPeriod } from "@hostel/shared/calendar/bs";
import { documentBsDate, documentInstant, drawFooter, loadInk } from "@/modules/billing/documents/document-parts";
import { Cursor } from "@/modules/billing/documents/layout";
import { COLORS, CONTENT_WIDTH, MARGIN, PAGE, SIZE } from "@/modules/billing/documents/theme";
import { sanitize } from "@/modules/reports/report-pdf";

/**
 * Every branch in one PDF: a cover page that puts the branches side by side —
 * one row each, the totals under them — and then each branch's own report or
 * statement, unchanged, in the order the switcher lists them (main first).
 *
 * The branch pages are the single-branch PDFs, copied in rather than redrawn,
 * so a branch's page in the all-branches file is exactly the page that branch
 * would print on its own.
 */

export type OverallKind = "report" | "statement";

/** One branch's figures for the month — whichever the cover of `kind` prints. */
export type OverallBranchFigures = {
  closing: number;
  collected: number;
  due: number;
  isBranch: boolean;
  moneyIn: number;
  moneyOut: number;
  name: string;
  residents: number;
  /** What the branch's wardens still hold (negative: the branch owes them). */
  staffCash: number;
};

export type OverallTable = { headers: string[]; rows: string[][]; total: string[] };

function rupees(value: number): string {
  const amount = `Rs ${Math.abs(Math.round(value)).toLocaleString("en-IN")}`;

  return Math.round(value) < 0 ? `-${amount}` : amount;
}

const COLUMNS: Record<OverallKind, { head: string; value: (row: OverallBranchFigures) => number; money: boolean }[]> = {
  report: [
    { head: "Residents", money: false, value: (row) => row.residents },
    { head: "Collected", money: true, value: (row) => row.collected },
    { head: "Due", money: true, value: (row) => row.due },
    { head: "Spent", money: true, value: (row) => row.moneyOut },
    { head: "Staff cash", money: true, value: (row) => row.staffCash },
  ],
  statement: [
    { head: "Money in", money: true, value: (row) => row.moneyIn },
    { head: "Money out", money: true, value: (row) => row.moneyOut },
    { head: "Net", money: true, value: (row) => row.moneyIn - row.moneyOut },
    { head: "Staff cash", money: true, value: (row) => row.staffCash },
    { head: "Balance", money: true, value: (row) => row.closing },
  ],
};

/** The cover's table: one row per branch, and the column sums. */
export function overallTable(kind: OverallKind, branches: OverallBranchFigures[]): OverallTable {
  const columns = COLUMNS[kind];
  const show = (money: boolean, value: number) => (money ? rupees(value) : value.toLocaleString("en-IN"));

  return {
    headers: ["Branch", ...columns.map((column) => column.head)],
    rows: branches.map((branch) => [
      `${branch.name}${branch.isBranch ? "" : " (main)"}`,
      ...columns.map((column) => show(column.money, column.value(branch))),
    ]),
    total: [
      `All ${branches.length} branches`,
      ...columns.map((column) =>
        show(column.money, branches.reduce((sum, branch) => sum + column.value(branch), 0)),
      ),
    ],
  };
}

const ROW = 18;
const BANNER = 54;
const WHITE = rgb(1, 1, 1);
const ZEBRA = rgb(0.957, 0.973, 0.965);
const NAME_WIDTH = 170;

function right(cursor: Cursor, edge: number, text: string, options: Parameters<Cursor["text"]>[2] = {}) {
  cursor.text(edge - cursor.width(text, options), text, options);
}

function clip(cursor: Cursor, text: string, width: number, size: number, bold: boolean) {
  const font = bold ? cursor.ink.bold : cursor.ink.regular;
  let cut = text;

  while (cut.length > 1 && font.widthOfTextAtSize(cut, size) > width) cut = cut.slice(0, -1);

  return cut === text ? text : `${cut.trimEnd()}...`;
}

function drawTable(cursor: Cursor, table: OverallTable) {
  const size = SIZE.label;
  const money = table.headers.length - 1;
  const step = (CONTENT_WIDTH - NAME_WIDTH) / money;
  const edge = (index: number) => MARGIN.left + NAME_WIDTH + step * (index + 1) - 6;
  const line = (cells: string[], bold: boolean) => {
    const font = bold ? cursor.ink.bold : cursor.ink.regular;

    cursor.text(MARGIN.left + 6, clip(cursor, sanitize(cells[0] ?? ""), NAME_WIDTH - 12, size, bold), { font, size });
    cells.slice(1).forEach((cell, index) => right(cursor, edge(index), cell, { font, size }));
  };

  cursor.page.drawRectangle({
    color: COLORS.ruleStrong,
    height: ROW + 2,
    width: CONTENT_WIDTH,
    x: MARGIN.left,
    y: cursor.top - 6,
  });
  cursor.text(MARGIN.left + 6, table.headers[0] ?? "", { color: WHITE, font: cursor.ink.bold, size });
  table.headers.slice(1).forEach((head, index) =>
    right(cursor, edge(index), head, { color: WHITE, font: cursor.ink.bold, size }),
  );
  cursor.down(ROW + 4);

  table.rows.forEach((cells, index) => {
    if (index % 2 === 0) {
      cursor.page.drawRectangle({ color: ZEBRA, height: ROW, width: CONTENT_WIDTH, x: MARGIN.left, y: cursor.top - 5 });
    }

    line(cells, false);
    cursor.down(ROW);
  });

  cursor.page.drawLine({
    color: COLORS.ruleStrong,
    end: { x: MARGIN.left + CONTENT_WIDTH, y: cursor.top + 12 },
    start: { x: MARGIN.left, y: cursor.top + 12 },
    thickness: 1.1,
  });
  line(table.total, true);
  cursor.down(ROW);
}

/** The cover, then every branch's own PDF appended page for page. */
export async function renderOverallPdf(input: {
  generatedAt?: Date;
  kind: OverallKind;
  parts: Uint8Array[];
  period: string;
  table: OverallTable;
}): Promise<Uint8Array> {
  const generatedAt = input.generatedAt ?? new Date();
  const pdf = await PDFDocument.create();
  const ink = await loadInk(pdf);
  const cursor = new Cursor(pdf.addPage([PAGE.width, PAGE.height]), ink);
  const title = input.kind === "report" ? "ALL BRANCHES REPORT" : "ALL BRANCHES STATEMENT";
  const period = formatBsPeriod(input.period);

  pdf.setTitle(`${PLATFORM_NAME} - all branches ${input.kind} ${period}`);
  pdf.setCreator(PLATFORM_NAME);

  cursor.page.drawRectangle({ color: COLORS.accent, height: BANNER, width: PAGE.width, x: 0, y: PAGE.height - BANNER });
  cursor.to(PAGE.height - BANNER / 2 - 6);
  cursor.text(MARGIN.left, PLATFORM_NAME, { color: WHITE, font: ink.bold, size: 17 });
  right(cursor, PAGE.width - MARGIN.right, title, { color: WHITE, font: ink.bold, size: 9, tracking: 1.4 });

  cursor.to(PAGE.height - BANNER - 30);
  cursor.text(MARGIN.left, `${input.table.rows.length} branches`, { font: ink.bold, size: 15 });
  cursor.down(17);
  cursor.text(MARGIN.left, `Period: ${period}`, { size: SIZE.body });
  right(cursor, PAGE.width - MARGIN.right, `Generated ${documentBsDate(generatedAt)}`, {
    color: COLORS.muted,
    size: SIZE.label,
  });
  cursor.down(36);

  drawTable(cursor, input.table);
  cursor.down(10);
  cursor.text(MARGIN.left, "Each branch's own pages follow, in this order.", { color: COLORS.muted, size: SIZE.label });

  drawFooter(cursor, {
    note: sanitize(`${PLATFORM_NAME} - generated ${documentInstant(generatedAt)} from live records.`),
    reference: "Cover",
  });

  for (const part of input.parts) {
    const source = await PDFDocument.load(part);
    const pages = await pdf.copyPages(source, source.getPageIndices());

    pages.forEach((page) => pdf.addPage(page));
  }

  return pdf.save();
}

export function overallPdfFilename(kind: OverallKind, period: string) {
  return `all-branches-${kind}-${period}.pdf`;
}
