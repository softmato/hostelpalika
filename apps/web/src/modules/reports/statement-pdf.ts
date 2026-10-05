import { PDFDocument, rgb } from "pdf-lib";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import { bsPeriodBounds, formatBsPeriod, periodParts } from "@hostel/shared/calendar/bs";
import { documentBsDate, documentInstant, drawFooter, loadInk } from "@/modules/billing/documents/document-parts";
import { Cursor } from "@/modules/billing/documents/layout";
import { COLORS, CONTENT_WIDTH, MARGIN, PAGE, SIZE } from "@/modules/billing/documents/theme";
import { hostelPeriodOf } from "@/lib/hostel-day";
import type { HostelLedger } from "@/modules/finance/invoice-list.service";
import { sanitize } from "@/modules/reports/report-pdf";

/**
 * The hostel statement as a bank-style PDF: money in (credits) and money out
 * (debits) between two Bikram Sambat months, one numbered line each, oldest
 * first, with a running balance — then the totals underneath.
 *
 * Built from the same ledger the app's statement screen reads
 * (`getHostelLedger`), so the paper and the screen cannot disagree. Expenses
 * are on it only when the ledger carries them, which is the owner only.
 */

export type StatementLine = {
  /** Positive. Which column it sits in is `kind`. */
  amount: number;
  at: Date;
  /**
   * `transfer` is cash the owner handed a warden: printed, never summed. The
   * warden's own expenses are the debits, so counting the handover as well
   * would spend the same rupee twice.
   */
  kind: "credit" | "debit" | "transfer";
  particulars: string;
};

export type StatementMonth = { credit: number; debit: number; month: string };

/** One warden's cash box over the statement: handed over and spent in range, left at its end. */
export type StaffCashLine = {
  given: number;
  left: number;
  name: string;
  /** Handed over in range, not yet confirmed by the warden. */
  pending: number;
  spent: number;
};

export type HostelStatement = {
  staff: StaffCashLine[];
  closing: number;
  /** BS `YYYY-MM`, inclusive. */
  from: string;
  lines: StatementLine[];
  months: StatementMonth[];
  /** Net of everything before `from` — the balance brought forward. */
  opening: number;
  to: string;
  totals: { credit: number; debit: number };
};

function validDate(value: Date | string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);

  return Number.isNaN(date.getTime()) ? null : date;
}

/** Noon Nepal time on a Gregorian `YYYY-MM-DD` — a day with no clock time. */
function nepalNoon(day: string): Date | null {
  return validDate(`${day}T12:00:00+05:45`);
}

/** Every money movement in the ledger, oldest first. */
export function ledgerLines(ledger: HostelLedger): StatementLine[] {
  const lines: StatementLine[] = [];

  for (const entry of ledger.entries) {
    const at = validDate(entry.paidDate) ?? validDate(entry.createdAt);

    if (entry.paidAmount > 0 && at) {
      const what = entry.month ? `${formatBsPeriod(entry.month)} rent` : "One-off charge";
      const who = entry.residentName?.trim() || "a resident";

      lines.push({ amount: entry.paidAmount, at, kind: "credit", particulars: `${what} - ${who}` });
    }
  }

  for (const expense of ledger.expenses ?? []) {
    const at = nepalNoon(expense.spentOn);

    if (expense.status !== "RECORDED" || expense.amount <= 0 || !at || expense.cashStatus === "DECLINED") {
      continue;
    }

    if (expense.cashTo) {
      const waiting = expense.cashStatus === "PENDING" ? ", not confirmed yet" : "";

      lines.push({
        amount: expense.amount,
        at,
        kind: "transfer",
        particulars: `Cash to ${expense.cashTo.name} - ${rupees(expense.amount)} (staff cash${waiting})`,
      });
      continue;
    }

    const what = expense.what.trim();
    const label = what ? `${expense.categoryLabel} - ${what}` : expense.categoryLabel;
    const salary = expense.salaryFor ? ` (${expense.salaryFor.name})` : "";
    // A warden's spend names whose cash box it came out of.
    const by = expense.payer === "STAFF" ? ` - by ${expense.recordedBy.name || "staff"}` : "";

    lines.push({ amount: expense.amount, at, kind: "debit", particulars: `${label}${salary}${by}` });
  }

  return lines.sort((left, right) => left.at.getTime() - right.at.getTime());
}

const signed = (line: StatementLine) =>
  line.kind === "credit" ? line.amount : line.kind === "debit" ? -line.amount : 0;

/**
 * Each warden's cash box across the statement: what reached them and what they
 * spent between `start` and `end`, and what they held at `end`.
 */
export function staffCashLines(ledger: HostelLedger, start: number, end: number): StaffCashLine[] {
  const boxes = new Map<string, StaffCashLine & { total: number }>();
  const box = (id: string, name: string) => {
    const entry = boxes.get(id) ?? { given: 0, left: 0, name, pending: 0, spent: 0, total: 0 };

    boxes.set(id, entry);

    return entry;
  };

  for (const expense of ledger.expenses ?? []) {
    const at = nepalNoon(expense.spentOn)?.getTime();

    if (expense.status !== "RECORDED" || at === undefined || at >= end) continue;

    const inRange = at >= start;

    if (expense.cashTo && expense.cashStatus !== "DECLINED") {
      const entry = box(expense.cashTo.userId, expense.cashTo.name);

      if (expense.cashStatus === "ACCEPTED") {
        entry.total += expense.amount;
        if (inRange) entry.given += expense.amount;
      } else if (inRange) {
        entry.pending += expense.amount;
      }
    } else if (expense.payer === "STAFF" && expense.recordedBy.role === "WARDEN") {
      const entry = box(expense.recordedBy.id, expense.recordedBy.name || "Warden");

      entry.total -= expense.amount;
      if (inRange) entry.spent += expense.amount;
    }
  }

  return [...boxes.values()]
    .map(({ total, ...line }) => ({ ...line, left: total }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

/** The statement between two BS months, inclusive. */
export function buildStatement(ledger: HostelLedger, from: string, to: string): HostelStatement {
  const [first, last] = from <= to ? [from, to] : [to, from];
  const start = bsPeriodBounds(first).start.getTime();
  const end = bsPeriodBounds(last).end.getTime();
  const all = ledgerLines(ledger);

  const opening = all
    .filter((line) => line.at.getTime() < start)
    .reduce((sum, line) => sum + signed(line), 0);
  const lines = all.filter((line) => line.at.getTime() >= start && line.at.getTime() < end);
  const totals = { credit: 0, debit: 0 };
  const byMonth = new Map<string, StatementMonth>();

  for (const line of lines) {
    if (line.kind === "transfer") continue;

    totals[line.kind] += line.amount;

    const month = hostelPeriodOf(line.at);
    const row = byMonth.get(month) ?? { credit: 0, debit: 0, month };

    row[line.kind] += line.amount;
    byMonth.set(month, row);
  }

  return {
    closing: opening + totals.credit - totals.debit,
    from: first,
    lines,
    months: [...byMonth.values()].sort((left, right) => left.month.localeCompare(right.month)),
    opening,
    staff: staffCashLines(ledger, start, end),
    to: last,
    totals,
  };
}

/* ── Drawing ───────────────────────────────────────────────────────────── */

const ROW = 17;
const BANNER = 54;
const BRAND_INK = COLORS.accent;
const WHITE = rgb(1, 1, 1);
/** Money out. The app's `--destructive`, darkened for print. */
const DEBIT_INK = rgb(0.72, 0.11, 0.11);
const ZEBRA = rgb(0.957, 0.973, 0.965);

/** S.N. · Date · Particulars · Debit · Credit · Balance — widths sum to the content width. */
const COLUMNS = (() => {
  const sn = 28;
  const date = 86;
  const money = 72;
  const particulars = CONTENT_WIDTH - sn - date - money * 3;
  const x0 = MARGIN.left;

  return {
    balance: { right: x0 + CONTENT_WIDTH - 4 },
    credit: { right: x0 + sn + date + particulars + money * 2 - 4 },
    date: { x: x0 + sn },
    debit: { right: x0 + sn + date + particulars + money - 4 },
    particulars: { width: particulars - 8, x: x0 + sn + date },
    sn: { x: x0 + 4 },
  };
})();

/** `Rs 1,20,000`, and `-Rs 650` for a negative — whole rupees, lakh grouping. */
function rupees(value: number): string {
  const amount = `Rs ${Math.abs(Math.round(value)).toLocaleString("en-IN")}`;

  return Math.round(value) < 0 ? `-${amount}` : amount;
}

/** A full-width line at the current height. Unlike `Cursor.rule()`, it does not move. */
function hairline(cursor: Cursor, strong = false) {
  cursor.page.drawLine({
    color: strong ? COLORS.ruleStrong : COLORS.rule,
    end: { x: MARGIN.left + CONTENT_WIDTH, y: cursor.top },
    start: { x: MARGIN.left, y: cursor.top },
    thickness: strong ? 1.1 : 0.6,
  });
}

function clip(cursor: Cursor, text: string, width: number, size: number): string {
  const font = cursor.ink.regular;

  if (font.widthOfTextAtSize(text, size) <= width) {
    return text;
  }

  let cut = text;

  while (cut.length > 1 && font.widthOfTextAtSize(`${cut}...`, size) > width) {
    cut = cut.slice(0, -1);
  }

  return `${cut.trimEnd()}...`;
}

function right(cursor: Cursor, edge: number, text: string, options: Parameters<Cursor["text"]>[2] = {}) {
  cursor.text(edge - cursor.width(text, options), text, options);
}

function rangeTitle(statement: HostelStatement): string {
  const from = formatBsPeriod(statement.from);

  return statement.from === statement.to ? from : `${from} to ${formatBsPeriod(statement.to)}`;
}

/** The green banner, the hostel's name under it, and the period. */
function banner(cursor: Cursor, hostelName: string, statement: HostelStatement, generatedAt: Date) {
  const { page, ink } = cursor;

  page.drawRectangle({ color: BRAND_INK, height: BANNER, width: PAGE.width, x: 0, y: PAGE.height - BANNER });
  cursor.to(PAGE.height - BANNER / 2 - 6);
  cursor.text(MARGIN.left, PLATFORM_NAME, { color: WHITE, font: ink.bold, size: 17 });
  right(cursor, PAGE.width - MARGIN.right, "ACCOUNT STATEMENT", {
    color: WHITE,
    font: ink.bold,
    size: 9,
    tracking: 1.4,
  });

  cursor.to(PAGE.height - BANNER - 30);
  cursor.text(MARGIN.left, hostelName, { font: ink.bold, size: 15 });
  cursor.down(17);
  cursor.text(MARGIN.left, `Statement period: ${rangeTitle(statement)}`, { size: SIZE.body });
  right(cursor, PAGE.width - MARGIN.right, `Generated ${documentBsDate(generatedAt)}`, {
    color: COLORS.muted,
    size: SIZE.label,
  });
  cursor.down(14);
  hairline(cursor, true);
  cursor.down(26);
}

function tableHead(cursor: Cursor) {
  const { ink } = cursor;
  const top = cursor.top + 11;

  cursor.page.drawRectangle({
    color: COLORS.ruleStrong,
    height: ROW + 2,
    width: CONTENT_WIDTH,
    x: MARGIN.left,
    y: top - ROW - 2,
  });

  const head = { color: WHITE, font: ink.bold, size: SIZE.label };

  cursor.text(COLUMNS.sn.x, "S.N.", head);
  cursor.text(COLUMNS.date.x, "Date (BS)", head);
  cursor.text(COLUMNS.particulars.x, "Particulars", head);
  right(cursor, COLUMNS.debit.right, "Debit", head);
  right(cursor, COLUMNS.credit.right, "Credit", head);
  right(cursor, COLUMNS.balance.right, "Balance", head);
  cursor.down(ROW + 2);
}

function row(
  cursor: Cursor,
  cells: { balance: number; credit?: number; date: string; debit?: number; particulars: string; sn: string },
  shade: boolean,
  bold = false,
) {
  const font = bold ? cursor.ink.bold : cursor.ink.regular;
  const size = SIZE.label;

  if (shade) {
    cursor.page.drawRectangle({
      color: ZEBRA,
      height: ROW,
      width: CONTENT_WIDTH,
      x: MARGIN.left,
      y: cursor.top - 5,
    });
  }

  cursor.text(COLUMNS.sn.x, cells.sn, { color: COLORS.muted, font, size });
  cursor.text(COLUMNS.date.x, cells.date, { font, size });
  cursor.text(COLUMNS.particulars.x, clip(cursor, cells.particulars, COLUMNS.particulars.width, size), {
    font,
    size,
  });

  if (cells.debit) {
    right(cursor, COLUMNS.debit.right, rupees(cells.debit), { color: DEBIT_INK, font, size });
  }

  if (cells.credit) {
    right(cursor, COLUMNS.credit.right, rupees(cells.credit), { color: BRAND_INK, font, size });
  }

  right(cursor, COLUMNS.balance.right, rupees(cells.balance), { font: cursor.ink.bold, size });
  cursor.down(ROW);
}

function summary(cursor: Cursor, statement: HostelStatement) {
  const { ink } = cursor;
  const pairs: [string, string, boolean?][] = [
    ["Opening balance", rupees(statement.opening)],
    ["Total credit (money in)", rupees(statement.totals.credit)],
    ["Total debit (money out)", rupees(statement.totals.debit)],
    ["Net for the period", rupees(statement.totals.credit - statement.totals.debit)],
    ["Closing balance", rupees(statement.closing), true],
  ];
  const boxWidth = 250;
  const x = PAGE.width - MARGIN.right - boxWidth;
  const height = pairs.length * ROW + 12;

  cursor.page.drawRectangle({
    borderColor: COLORS.ruleStrong,
    borderWidth: 0.8,
    height,
    width: boxWidth,
    x,
    y: cursor.top - height + 12,
  });

  cursor.down(4);

  for (const [label, value, strong] of pairs) {
    cursor.text(x + 10, label, { font: strong ? ink.bold : ink.regular, size: SIZE.body });
    right(cursor, x + boxWidth - 10, value, { font: ink.bold, size: SIZE.body });
    cursor.down(ROW);
  }

  cursor.down(10);
}

function monthTable(cursor: Cursor, months: StatementMonth[]) {
  const { ink } = cursor;
  const cols = { credit: MARGIN.left + 300, debit: MARGIN.left + 200, month: MARGIN.left + 4, net: MARGIN.left + 400 };

  cursor.text(MARGIN.left, "MONTH BY MONTH", { color: COLORS.muted, font: ink.bold, size: SIZE.eyebrow, tracking: 1.4 });
  cursor.down(14);

  const head = { font: ink.bold, size: SIZE.label };

  cursor.text(cols.month, "Month", head);
  right(cursor, cols.debit, "Debit", head);
  right(cursor, cols.credit, "Credit", head);
  right(cursor, cols.net, "Net", head);
  cursor.down(6);
  hairline(cursor);
  cursor.down(14);

  for (const month of months) {
    const size = SIZE.label;

    cursor.text(cols.month, formatBsPeriod(month.month), { size });
    right(cursor, cols.debit, rupees(month.debit), { color: DEBIT_INK, size });
    right(cursor, cols.credit, rupees(month.credit), { color: BRAND_INK, size });
    right(cursor, cols.net, rupees(month.credit - month.debit), { font: ink.bold, size });
    cursor.down(ROW - 2);
  }

  cursor.down(8);
}

/** Per warden: handed over, spent, and what they still hold — or what the hostel owes them. */
function staffTable(cursor: Cursor, staff: StaffCashLine[]) {
  const { ink } = cursor;
  const cols = { given: MARGIN.left + 290, left: MARGIN.left + CONTENT_WIDTH - 4, name: MARGIN.left + 4, spent: MARGIN.left + 390 };
  const size = SIZE.label;

  cursor.text(MARGIN.left, "STAFF CASH", { color: COLORS.muted, font: ink.bold, size: SIZE.eyebrow, tracking: 1.4 });
  cursor.down(14);

  const head = { font: ink.bold, size };

  cursor.text(cols.name, "Warden", head);
  right(cursor, cols.given, "Given", head);
  right(cursor, cols.spent, "Spent", head);
  right(cursor, cols.left, "Left with them", head);
  cursor.down(6);
  hairline(cursor);
  cursor.down(14);

  for (const line of staff) {
    const waiting = line.pending > 0 ? ` (${rupees(line.pending)} not confirmed)` : "";

    cursor.text(cols.name, clip(cursor, sanitize(`${line.name}${waiting}`), 260, size), { size });
    right(cursor, cols.given, rupees(line.given), { color: BRAND_INK, size });
    right(cursor, cols.spent, rupees(line.spent), { color: DEBIT_INK, size });
    right(cursor, cols.left, line.left < 0 ? `Hostel owes ${rupees(-line.left)}` : rupees(line.left), {
      font: ink.bold,
      size,
    });
    cursor.down(ROW - 2);
  }

  cursor.down(8);
}

/**
 * The statement, paginated: the banner on page one, the table head repeated on
 * every page, and the totals after the last line.
 */
export async function renderStatementPdf(
  statement: HostelStatement,
  hostelName: string,
  generatedAt: Date = new Date(),
): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const ink = await loadInk(pdf);
  const name = sanitize(hostelName).trim() || "Your hostel";
  const pages: Cursor[] = [];
  const newPage = (first: boolean) => {
    const cursor = new Cursor(pdf.addPage([PAGE.width, PAGE.height]), ink);

    if (first) {
      banner(cursor, name, statement, generatedAt);
    } else {
      cursor.text(MARGIN.left, `${PLATFORM_NAME} - ${name}`, { color: COLORS.muted, size: SIZE.label });
      right(cursor, PAGE.width - MARGIN.right, rangeTitle(statement), { color: COLORS.muted, size: SIZE.label });
      cursor.down(10);
      hairline(cursor);
      cursor.down(26);
    }

    pages.push(cursor);

    return cursor;
  };
  const floor = MARGIN.bottom + 40;

  pdf.setTitle(`${name} - statement ${rangeTitle(statement)}`);
  pdf.setCreator(PLATFORM_NAME);

  let cursor = newPage(true);

  tableHead(cursor);
  row(cursor, { balance: statement.opening, date: "", particulars: "Balance brought forward", sn: "" }, false, true);

  let balance = statement.opening;

  statement.lines.forEach((line, index) => {
    if (cursor.top < floor) {
      cursor = newPage(false);
      tableHead(cursor);
    }

    balance += signed(line);
    row(
      cursor,
      {
        balance,
        // A transfer prints in neither column: its amount is in the particulars.
        credit: line.kind === "credit" ? line.amount : undefined,
        date: documentBsDate(line.at),
        debit: line.kind === "debit" ? line.amount : undefined,
        particulars: sanitize(line.particulars),
        sn: String(index + 1),
      },
      index % 2 === 0,
    );
  });

  if (statement.lines.length === 0) {
    cursor.text(COLUMNS.particulars.x, "No money moved in this period.", { color: COLORS.muted, size: SIZE.label });
    cursor.down(ROW);
  }

  cursor.down(ROW - 12);
  hairline(cursor, true);
  cursor.down(14);

  // Totals line under the columns, the way a passbook closes a page.
  cursor.text(COLUMNS.particulars.x, "Total", { font: ink.bold, size: SIZE.label });
  right(cursor, COLUMNS.debit.right, rupees(statement.totals.debit), { color: DEBIT_INK, font: ink.bold, size: SIZE.label });
  right(cursor, COLUMNS.credit.right, rupees(statement.totals.credit), { color: BRAND_INK, font: ink.bold, size: SIZE.label });
  right(cursor, COLUMNS.balance.right, rupees(statement.closing), { font: ink.bold, size: SIZE.label });
  cursor.down(28);

  if (cursor.top - (5 * ROW + 12) < floor) {
    cursor = newPage(false);
  }

  summary(cursor, statement);

  if (statement.months.length > 1) {
    if (cursor.top - (34 + statement.months.length * (ROW - 2)) < floor) {
      cursor = newPage(false);
    }

    monthTable(cursor, statement.months);
  }

  if (statement.staff.length > 0) {
    if (cursor.top - (34 + statement.staff.length * (ROW - 2)) < floor) {
      cursor = newPage(false);
    }

    staffTable(cursor, statement.staff);
  }

  const note = sanitize(
    `${PLATFORM_NAME} - generated ${documentInstant(generatedAt)} from live records. Debit = money out, Credit = money in.`,
  );

  pages.forEach((page, index) => drawFooter(page, { note, reference: `Page ${index + 1} of ${pages.length}` }));

  return pdf.save();
}

/** `statement-2083-01-to-2083-06.pdf`. */
export function statementPdfFilename(from: string, to: string): string {
  return from === to ? `statement-${from}.pdf` : `statement-${from}-to-${to}.pdf`;
}

/** A BS period key the calendar can place — guards the route's query. */
export function isStatementPeriod(value: string): boolean {
  return Boolean(periodParts(value));
}
