import { PDFDocument, type PDFFont, type RGB } from "pdf-lib";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import { bsMonthName, formatBsPeriod, periodParts, toBs } from "@hostel/shared/calendar/bs";
import { documentBsDate, documentInstant, drawFooter, loadInk } from "@/modules/billing/documents/document-parts";
import { Cursor } from "@/modules/billing/documents/layout";
import {
  COLORS,
  CONTENT_WIDTH,
  MARGIN,
  PAGE,
  SIZE,
  SPACE,
} from "@/modules/billing/documents/theme";
import type { PerformanceReport } from "@/modules/reports/performance-report.service";
import { sanitize } from "@/modules/reports/report-pdf";

/**
 * The monthly performance report, as two pages of A4.
 *
 * Page one is money: four headline figures, then rent billed against rent
 * collected for the month and the five before it. Page two is people and
 * reach: who lives here and who is in tonight, who moved in and out, how many
 * beds are taken, how often the public listing was seen, and what is still open.
 *
 * ## Stationery, not a dashboard
 *
 * Built on the plan invoice's grammar (`billing/documents`) — Helvetica for
 * words, Courier for figures, one green, hairlines rather than boxes — because
 * this is the document an owner hands to a partner or a bank, and it should look
 * like it came from the same place as their invoices. None of the invoice's
 * *instrument* furniture comes with it: no stamp, no document number, no
 * proof-of-payment wording. `report-pdf.ts` explains why that line matters.
 *
 * There is no red here either, for the invoice's reason. A month with money
 * still owed is an ordinary month.
 *
 * ## Fixed layout
 *
 * Every block is a known height — six trend months, four listing rows, two
 * operations rows — so the two pages are two pages by construction and nothing
 * paginates. The payload is the variable; the page is not.
 */

const GUTTER = 14;
const ROW = 18;

type Ink = Cursor["ink"];

/* ── Formatting ────────────────────────────────────────────────────────── */

/** `Rs 1,20,000` — whole rupees, lakh grouping. A report rounds; an invoice does not. */
export function rupees(value: number): string {
  return `Rs ${Math.round(value).toLocaleString("en-IN")}`;
}

function count(value: number): string {
  return Math.round(value).toLocaleString("en-IN");
}

/** `1 review`, `18 reviews`. */
function plural(value: number, noun: string): string {
  return `${count(value)} ${noun}${value === 1 ? "" : "s"}`;
}

function percent(value: number | null): string {
  return value === null ? "-" : `${Math.round(value)}%`;
}

/** `+12%`, `-8%`, `New`, or a dash when there is nothing either side. */
export function changeLabel(current: number, previous: number): string {
  if (previous === 0) {
    return current === 0 ? "-" : "New";
  }

  const delta = Math.round(((current - previous) / previous) * 100);

  return delta === 0 ? "No change" : `${delta > 0 ? "+" : ""}${delta}%`;
}

/** `Bhadra 2083` — the BS era is on the range line under it. */
function periodName(month: string): string {
  return formatBsPeriod(month).replace(/ BS$/, "") || month;
}

function monthOnly(month: string): string {
  const parts = periodParts(month);

  return parts ? bsMonthName(parts.month) : month;
}

/** `1 - 17 Bhadra 2083 BS`. */
function rangeLabel(start: Date, end: Date): string {
  const from = toBs(start);
  const to = toBs(end);
  const toName = `${bsMonthName(to.month)} ${to.year} BS`;

  return from.month === to.month && from.year === to.year
    ? `${from.day} - ${to.day} ${toName}`
    : `${from.day} ${bsMonthName(from.month)} - ${to.day} ${toName}`;
}

function methodLabel(method: string): string {
  const known: Record<string, string> = {
    BANK_TRANSFER: "Bank transfer",
    CASH: "Cash",
    ESEWA: "eSewa",
    FONEPAY: "Fonepay",
    KHALTI: "Khalti",
  };

  return (
    known[method] ??
    method
      .toLowerCase()
      .split("_")
      .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
      .join(" ")
  );
}

/* ── Drawing helpers ───────────────────────────────────────────────────── */

/** The largest size ≤ `size` at which `text` fits `width`. */
function fittedSize(font: PDFFont, text: string, size: number, width: number): number {
  let fitted = size;

  while (fitted > 7 && font.widthOfTextAtSize(text, fitted) > width) {
    fitted -= 0.5;
  }

  return fitted;
}

function rightText(
  cursor: Cursor,
  right: number,
  value: string,
  options: { color?: RGB; font?: PDFFont; size?: number } = {},
) {
  const font = options.font ?? cursor.ink.regular;
  const size = options.size ?? SIZE.body;

  cursor.text(right - font.widthOfTextAtSize(value, size), value, { ...options, font, size });
}

function hairline(cursor: Cursor, y: number, from = MARGIN.left, to = PAGE.width - MARGIN.right) {
  cursor.page.drawLine({
    color: COLORS.rule,
    end: { x: to, y },
    start: { x: from, y },
    thickness: 0.6,
  });
}

/** An eyebrow and a section name under it. */
function sectionTitle(cursor: Cursor, eyebrow: string, title: string, note?: string) {
  cursor.eyebrow(MARGIN.left, eyebrow);
  cursor.text(MARGIN.left, title, { font: cursor.ink.bold, size: SIZE.partyName });

  if (note) {
    rightText(cursor, PAGE.width - MARGIN.right, note, {
      color: COLORS.muted,
      size: SIZE.footnote,
    });
  }

  cursor.down(SPACE.line + 4);
}

type Figure = { label: string; sub: string; value: string };

/**
 * A row of headline figures with hairlines between them: label, figure, context.
 * Returns nothing and leaves the cursor under the row.
 */
function figureRow(cursor: Cursor, figures: Figure[]) {
  const width = (CONTENT_WIDTH - GUTTER * (figures.length - 1)) / figures.length;
  const top = cursor.top;

  figures.forEach((figure, index) => {
    const x = MARGIN.left + index * (width + GUTTER);
    const valueSize = fittedSize(cursor.ink.monoBold, figure.value, 16, width - 4);

    cursor.to(top);
    cursor.eyebrow(x, figure.label);
    cursor.down(5);
    cursor.text(x, figure.value, { font: cursor.ink.monoBold, size: valueSize });
    cursor.down(15);
    cursor.text(x, figure.sub, {
      color: COLORS.muted,
      size: fittedSize(cursor.ink.regular, figure.sub, SIZE.footnote, width - 4),
    });

    if (index > 0) {
      const lineX = x - GUTTER / 2;

      cursor.page.drawLine({
        color: COLORS.rule,
        end: { x: lineX, y: top - 44 },
        start: { x: lineX, y: top + 8 },
        thickness: 0.6,
      });
    }
  });

  cursor.to(top - 44 - SPACE.tight);
}

type Column = { align?: "left" | "right"; label: string; width: number };

/** A plain table: tracked header, hairline, rows of text with right-aligned figures. */
function table(
  cursor: Cursor,
  columns: Column[],
  rows: { cells: string[]; strong?: boolean }[],
) {
  const total = columns.reduce((sum, column) => sum + column.width, 0);
  const scale = CONTENT_WIDTH / total;
  let x = MARGIN.left;
  const edges = columns.map((column) => {
    const left = x;

    x += column.width * scale;

    return { left, right: x };
  });

  columns.forEach((column, index) => {
    const label = column.label.toUpperCase();

    if (column.align === "right") {
      rightText(cursor, edges[index].right, label, { color: COLORS.label, size: SIZE.eyebrow });
    } else {
      cursor.text(edges[index].left, label, { color: COLORS.label, size: SIZE.eyebrow });
    }
  });

  hairline(cursor, cursor.top - 6);
  cursor.down(ROW);

  for (const row of rows) {
    row.cells.forEach((cell, index) => {
      const column = columns[index];
      const font =
        column.align === "right"
          ? row.strong
            ? cursor.ink.monoBold
            : cursor.ink.mono
          : row.strong
            ? cursor.ink.bold
            : cursor.ink.regular;

      if (column.align === "right") {
        rightText(cursor, edges[index].right, cell, { font });
      } else {
        cursor.text(edges[index].left, cell, { font });
      }
    });

    cursor.down(ROW);
  }
}

/** Label on the left of a column, value against its right edge. */
function pair(
  cursor: Cursor,
  left: number,
  right: number,
  label: string,
  value: string,
  options: { strong?: boolean } = {},
) {
  cursor.text(left, label, { color: COLORS.label, size: SIZE.label });
  rightText(cursor, right, value, {
    font: options.strong ? cursor.ink.monoBold : cursor.ink.mono,
  });
}

/**
 * One track split into parts, with a legend under it. Parts are drawn in order
 * from the left; whatever the parts do not claim stays empty ground.
 */
function splitBar(
  cursor: Cursor,
  parts: { color: RGB; label: string; value: number }[],
  total: number,
) {
  const height = 9;
  const y = cursor.top - height;

  cursor.page.drawRectangle({
    color: COLORS.rule,
    height,
    opacity: 0.35,
    width: CONTENT_WIDTH,
    x: MARGIN.left,
    y,
  });

  if (total > 0) {
    let x = MARGIN.left;

    for (const part of parts) {
      const width = (Math.max(part.value, 0) / total) * CONTENT_WIDTH;

      if (width > 0) {
        cursor.page.drawRectangle({ color: part.color, height, width, x, y });
        x += width;
      }
    }
  }

  cursor.down(height + 14);

  let x = MARGIN.left;

  for (const part of parts) {
    cursor.page.drawRectangle({ color: part.color, height: 7, width: 7, x, y: cursor.top - 0.5 });
    x += 11;
    x += cursor.text(x, part.label, { color: COLORS.muted, size: SIZE.label }) + 6;
    x += cursor.text(x, count(part.value), { font: cursor.ink.monoBold, size: SIZE.label }) + 18;
  }

  cursor.down(SPACE.line);
}

/** Billed against collected, a pair of bars per month. */
function trendChart(cursor: Cursor, trend: PerformanceReport["finance"]["trend"]) {
  const height = 150;
  const top = cursor.top;
  const base = top - height;
  const peak = Math.max(0, ...trend.map((point) => Math.max(point.billed, point.collected)));

  if (peak <= 0) {
    cursor.text(MARGIN.left, "Nothing was billed in these six months.", {
      color: COLORS.muted,
    });
    cursor.down(SPACE.block);

    return;
  }

  // The peak as a faint top line, so the bars have a scale to be read against.
  hairline(cursor, top);
  cursor.to(top + 4);
  rightText(cursor, PAGE.width - MARGIN.right, rupees(peak), {
    color: COLORS.muted,
    font: cursor.ink.mono,
    size: SIZE.footnote,
  });

  const group = CONTENT_WIDTH / trend.length;
  const bar = Math.min(22, group * 0.26);

  trend.forEach((point, index) => {
    const centre = MARGIN.left + group * index + group / 2;
    const billedHeight = (point.billed / peak) * (height - 8);
    const collectedHeight = (Math.min(point.collected, peak) / peak) * (height - 8);

    if (billedHeight > 0) {
      cursor.page.drawRectangle({
        color: COLORS.rule,
        height: billedHeight,
        width: bar,
        x: centre - bar - 1.5,
        y: base,
      });
    }

    if (collectedHeight > 0) {
      cursor.page.drawRectangle({
        color: COLORS.accent,
        height: collectedHeight,
        width: bar,
        x: centre + 1.5,
        y: base,
      });
    }

    cursor.to(base - 13);

    const label = monthOnly(point.month);
    const last = index === trend.length - 1;
    const font = last ? cursor.ink.bold : cursor.ink.regular;

    cursor.text(centre - font.widthOfTextAtSize(label, SIZE.label) / 2, label, {
      color: last ? COLORS.text : COLORS.muted,
      font,
      size: SIZE.label,
    });
  });

  cursor.page.drawLine({
    color: COLORS.ruleStrong,
    end: { x: PAGE.width - MARGIN.right, y: base },
    start: { x: MARGIN.left, y: base },
    thickness: 0.8,
  });

  cursor.to(base - 13 - SPACE.line);

  let x = MARGIN.left;

  for (const [color, label] of [
    [COLORS.rule, "Billed"],
    [COLORS.accent, "Collected"],
  ] as const) {
    cursor.page.drawRectangle({ color, height: 7, width: 7, x, y: cursor.top - 0.5 });
    x += 11 + cursor.text(x + 11, label, { color: COLORS.muted, size: SIZE.label }) + 18;
  }

  cursor.down(SPACE.line + 6);
}

/* ── Pages ─────────────────────────────────────────────────────────────── */

function masthead(cursor: Cursor, report: PerformanceReport, hostelName: string) {
  const right = PAGE.width - MARGIN.right;
  const top = cursor.top;
  const title = periodName(report.period.month);
  const range = `${rangeLabel(new Date(report.period.start), new Date(report.period.end))}${
    report.period.isCurrent ? " (so far)" : ""
  }`;

  cursor.text(MARGIN.left, hostelName, {
    font: cursor.ink.bold,
    size: fittedSize(cursor.ink.bold, hostelName, SIZE.issuer + 3, CONTENT_WIDTH * 0.55),
  });
  rightText(cursor, right, title, { font: cursor.ink.bold, size: SIZE.issuer + 3 });
  cursor.to(top - 17);
  cursor.text(MARGIN.left, "Monthly performance report", {
    color: COLORS.label,
    size: SIZE.label,
  });
  rightText(cursor, right, range, { color: COLORS.muted, size: SIZE.label });
  cursor.down(SPACE.tight);
  cursor.ruleStrong();
}

function runningHeader(cursor: Cursor, report: PerformanceReport, hostelName: string) {
  cursor.text(MARGIN.left, hostelName, { color: COLORS.label, size: SIZE.label });
  rightText(cursor, PAGE.width - MARGIN.right, periodName(report.period.month), {
    color: COLORS.label,
    size: SIZE.label,
  });
  cursor.down(SPACE.tight);
  cursor.ruleStrong();
}

function moneyPage(cursor: Cursor, report: PerformanceReport) {
  const { beds, finance, residents } = report;
  const monthName = monthOnly(report.period.month);
  const previousName = monthOnly(report.period.previousMonth);

  figureRow(cursor, [
    {
      label: "Collected",
      sub: finance.billed > 0 ? `of ${rupees(finance.billed)} billed` : "Nothing billed yet",
      value: rupees(finance.collected),
    },
    {
      label: "Collection rate",
      sub:
        finance.previous.collectionRate === null
          ? `${previousName}: nothing billed`
          : `${previousName}: ${percent(finance.previous.collectionRate)}`,
      value: percent(finance.collectionRate),
    },
    {
      label: "Residents",
      sub: `${residents.movedIn} in, ${residents.movedOut} out in ${monthName}`,
      value: count(residents.now.total),
    },
    {
      label: "Occupancy",
      sub: `${count(beds.occupied)} of ${count(beds.total)} beds`,
      value: percent(beds.occupancyRate),
    },
  ]);

  cursor.rule();

  sectionTitle(cursor, "Money", `Rent for ${monthName}`);

  const half = (CONTENT_WIDTH - GUTTER * 2) / 2;
  const leftEnd = MARGIN.left + half;
  const rightStart = leftEnd + GUTTER * 2;
  const rightEnd = PAGE.width - MARGIN.right;
  const rows: [string, string, string, string][] = [
    ["Billed", rupees(finance.billed), "Owed across all months", rupees(finance.outstandingAllTime)],
    ["Collected", rupees(finance.collected), "Payment proofs to check", count(finance.pendingProofs)],
    [
      "Still owed",
      rupees(finance.outstanding),
      `Collected for ${previousName}`,
      rupees(finance.previous.collected),
    ],
  ];

  for (const [leftLabel, leftValue, rightLabel, rightValue] of rows) {
    pair(cursor, MARGIN.left, leftEnd, leftLabel, leftValue);
    pair(cursor, rightStart, rightEnd, rightLabel, rightValue);
    cursor.down(ROW);
  }

  cursor.down(SPACE.tight + 6);
  cursor.eyebrow(MARGIN.left, "Last six months");
  cursor.down(10);
  trendChart(cursor, finance.trend);

  table(
    cursor,
    [
      { label: "Month", width: 3 },
      { align: "right", label: "Billed", width: 2.5 },
      { align: "right", label: "Collected", width: 2.5 },
      { align: "right", label: "Still owed", width: 2.5 },
      { align: "right", label: "Rate", width: 1.5 },
    ],
    finance.trend.map((point, index) => ({
      cells: [
        periodName(point.month),
        rupees(point.billed),
        rupees(point.collected),
        rupees(Math.max(point.billed - point.collected, 0)),
        percent(point.collectionRate),
      ],
      strong: index === finance.trend.length - 1,
    })),
  );

  if (finance.methods.length > 0) {
    cursor.down(6);
    cursor.text(MARGIN.left, `Paid in ${monthName} by`, { color: COLORS.label, size: SIZE.label });
    cursor.text(
      MARGIN.left + 120,
      finance.methods
        .map((entry) => `${methodLabel(entry.method)} (${plural(entry.count, "invoice")})`)
        .join(",   "),
      { size: SIZE.label },
    );
  }
}

function peoplePage(cursor: Cursor, report: PerformanceReport) {
  const { beds, listing, operations, residents } = report;
  const monthName = monthOnly(report.period.month);
  const previousName = monthOnly(report.period.previousMonth);

  sectionTitle(cursor, "People", "Residents", "Living here and tonight: as of when this was generated");

  const { now } = residents;

  figureRow(cursor, [
    {
      label: "Living here",
      sub: `${now.active} active, ${now.pending} pending, ${now.suspended} suspended`,
      value: count(now.total),
    },
    {
      label: `Moved in (${monthName})`,
      sub: "New residents this month",
      value: count(residents.movedIn),
    },
    {
      label: `Moved out (${monthName})`,
      sub: `Net ${residents.movedIn - residents.movedOut >= 0 ? "+" : ""}${residents.movedIn - residents.movedOut}`,
      value: count(residents.movedOut),
    },
  ]);

  cursor.down(SPACE.tight);
  cursor.eyebrow(MARGIN.left, "Tonight");
  cursor.down(2);
  splitBar(
    cursor,
    [
      { color: COLORS.accent, label: "Inside", value: residents.tonight.inside },
      { color: COLORS.label, label: "Outside", value: residents.tonight.outside },
      { color: COLORS.rule, label: "Not answered", value: residents.tonight.notAnswered },
    ],
    now.total,
  );

  cursor.down(10);
  cursor.eyebrow(MARGIN.left, "Beds");
  cursor.down(2);
  splitBar(
    cursor,
    [
      { color: COLORS.accent, label: "Occupied", value: beds.occupied },
      { color: COLORS.rule, label: "Free", value: beds.vacant },
    ],
    beds.total,
  );

  cursor.down(4);
  cursor.rule();

  sectionTitle(cursor, "Reach", "Public listing");

  const reach: [string, { current: number; previous: number }][] = [
    ["Appeared in search results", listing.appearances],
    ["Page views", listing.views],
    ["Unique visitors", listing.visitors],
    ["Inquiries", listing.inquiries],
  ];

  table(
    cursor,
    [
      { label: "", width: 4 },
      { align: "right", label: monthName, width: 2 },
      { align: "right", label: previousName, width: 2 },
      { align: "right", label: "Change", width: 2 },
    ],
    reach.map(([label, { current, previous }]) => ({
      cells: [label, count(current), count(previous), changeLabel(current, previous)],
    })),
  );

  cursor.down(4);
  pair(
    cursor,
    MARGIN.left,
    PAGE.width - MARGIN.right,
    `Inquiries from ${monthName} that became residents`,
    count(listing.inquiriesConverted),
  );
  cursor.down(ROW);
  pair(
    cursor,
    MARGIN.left,
    PAGE.width - MARGIN.right,
    listing.rating.total > 0
      ? `Rating, from ${plural(listing.rating.total, "review")} (${listing.rating.newThisMonth} new in ${monthName})`
      : "Rating",
    listing.rating.average === null ? "No reviews yet" : `${listing.rating.average.toFixed(1)} / 5`,
  );
  cursor.down(ROW + SPACE.tight);
  cursor.rule();

  sectionTitle(cursor, "Operations", "Complaints and repairs");

  table(
    cursor,
    [
      { label: "", width: 3 },
      { align: "right", label: `Raised in ${monthName}`, width: 2.4 },
      { align: "right", label: "Closed", width: 1.8 },
      { align: "right", label: "Open now", width: 1.8 },
      { align: "right", label: "Past due", width: 1.8 },
    ],
    [
      {
        cells: [
          "Complaints",
          count(operations.complaints.raised),
          count(operations.complaints.resolved),
          count(operations.complaints.open),
          count(operations.complaints.pastSla),
        ],
      },
      {
        cells: [
          "Repairs",
          count(operations.repairs.raised),
          count(operations.repairs.completed),
          count(operations.repairs.open),
          "-",
        ],
      },
    ],
  );
}

const FLOOR = MARGIN.bottom + 40;

/**
 * Money out, for the owner's copy only (`report.moneyOut` is `null` for a
 * warden): the month's spending by category, each warden's cash box — handed
 * over, spent, left — and then every line, so the owner can follow the cash
 * they gave out rupee by rupee. Returns the pages it drew.
 */
function moneyOutPages(
  pdf: PDFDocument,
  ink: Ink,
  report: PerformanceReport,
  hostelName: string,
): Cursor[] {
  const out = report.moneyOut;

  if (!out) return [];

  const pages: Cursor[] = [];
  const page = () => {
    const cursor = new Cursor(pdf.addPage([PAGE.width, PAGE.height]), ink);

    runningHeader(cursor, report, hostelName);
    cursor.down(SPACE.line);
    pages.push(cursor);

    return cursor;
  };
  let cursor = page();
  const withStaff = out.staff.reduce((sum, box) => sum + Math.max(0, box.left), 0);
  const owed = out.staff.reduce((sum, box) => sum + Math.max(0, -box.left), 0);

  sectionTitle(cursor, "MONEY OUT", "Where the money went", monthOnly(report.period.month));
  figureRow(cursor, [
    { label: "Spent", sub: `${out.rows.filter((row) => !row.cashTo).length} expenses`, value: rupees(out.out) },
    { label: "With wardens", sub: "Cash they still hold", value: rupees(withStaff) },
    { label: "Owed to wardens", sub: "Paid from their pocket", value: rupees(owed) },
  ]);
  cursor.down(SPACE.line);

  if (out.byCategory.length > 0) {
    table(
      cursor,
      [
        { label: "Spent on", width: 3 },
        { align: "right", label: "Amount", width: 1.2 },
        { align: "right", label: "Share", width: 0.8 },
      ],
      out.byCategory.map((row) => ({
        cells: [
          sanitize(row.label),
          rupees(row.amount),
          out.out > 0 ? `${Math.round((row.amount / out.out) * 100)}%` : "-",
        ],
      })),
    );
    cursor.down(SPACE.line);
  }

  if (out.staff.length > 0) {
    if (cursor.top - (out.staff.length + 3) * ROW < FLOOR) cursor = page();

    sectionTitle(cursor, "STAFF CASH", "Each warden's cash box");
    table(
      cursor,
      [
        { label: "Warden", width: 2.4 },
        { align: "right", label: "Given", width: 1.2 },
        { align: "right", label: "Spent", width: 1.2 },
        { align: "right", label: "Left", width: 1.4 },
      ],
      out.staff.map((box) => ({
        cells: [
          sanitize(box.pending > 0 ? `${box.name} (${rupees(box.pending)} waiting)` : box.name),
          rupees(box.given),
          rupees(box.spent),
          box.left < 0 ? `owes ${rupees(-box.left)}` : rupees(box.left),
        ],
      })),
    );
    cursor.down(SPACE.line);
  }

  const columns = [
    { label: "Date (BS)", width: 1.1 },
    { label: "What", width: 2.6 },
    { label: "By", width: 1.3 },
    { label: "Paid by", width: 0.9 },
    { align: "right" as const, label: "Amount", width: 1.1 },
  ];
  const lines = out.rows.map((row) => ({
    cells: [
      documentBsDate(new Date(`${row.spentOn}T12:00:00+05:45`)),
      sanitize(
        row.cashTo
          ? `Cash to ${row.cashTo.name}${row.cashStatus === "PENDING" ? " (waiting)" : ""}`
          : row.what
            ? `${row.categoryLabel} - ${row.what}`
            : row.categoryLabel,
      ).slice(0, 48),
      sanitize(row.recordedBy.name || "Staff").slice(0, 22),
      row.paidBy === "ESEWA" ? "eSewa" : row.paidBy === "KHALTI" ? "Khalti" : row.paidBy === "BANK" ? "Bank" : "Cash",
      rupees(row.amount),
    ],
  }));

  if (lines.length === 0) return pages;

  let start = 0;
  let title = true;

  while (start < lines.length) {
    if (cursor.top - 5 * ROW < FLOOR) cursor = page();

    if (title) {
      sectionTitle(cursor, "EVERY EXPENSE", "Line by line", "Cash to a warden is not counted as spent");
      title = false;
    }

    const fits = Math.max(1, Math.floor((cursor.top - FLOOR) / ROW) - 1);

    table(cursor, columns, lines.slice(start, start + fits));
    start += fits;
  }

  return pages;
}

export async function renderPerformanceReportPdf(report: PerformanceReport): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const ink: Ink = await loadInk(pdf);
  const hostelName = sanitize(report.hostelName).trim() || "Your hostel";
  const generatedAt = new Date(report.generatedAt);
  const note = sanitize(`${PLATFORM_NAME} - generated ${documentInstant(generatedAt)} from live records`);

  pdf.setTitle(`${hostelName} - ${periodName(report.period.month)} performance report`);
  pdf.setCreator(PLATFORM_NAME);

  const first = new Cursor(pdf.addPage([PAGE.width, PAGE.height]), ink);

  masthead(first, report, hostelName);
  moneyPage(first, report);

  const second = new Cursor(pdf.addPage([PAGE.width, PAGE.height]), ink);

  runningHeader(second, report, hostelName);
  peoplePage(second, report);

  const pages = [first, second, ...moneyOutPages(pdf, ink, report, hostelName)];

  pages.forEach((page, index) => drawFooter(page, { note, reference: `Page ${index + 1} of ${pages.length}` }));

  return pdf.save();
}

/** `performance-2083-05.pdf`. */
export function performancePdfFilename(month: string): string {
  return `performance-${month}.pdf`;
}
