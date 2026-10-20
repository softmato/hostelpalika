import { formatHostelDate } from "@hostel/shared/calendar/bs";

/**
 * The statement's rows and their arithmetic, shared by the hostel's statement
 * and the resident's — the web side of the app's `lib/hostel-statement.ts`.
 * A row is money in, money out, or a move (cash handed to staff: listed,
 * never counted as spending).
 */

export type StatementRow = {
  amount: number;
  /** ISO; `null` when nothing records when the money moved. */
  at: string | null;
  /** Small labels under the title — a category, "Part payment". */
  badges?: string[];
  /** Running balance after this row, oldest first; set by `withBalances`. */
  balance?: number | null;
  /** Label/value pairs for the detail sheet. */
  facts: [string, string][];
  id: string;
  kind: "in" | "move" | "out";
  /** Where the row's own record lives — a resident, the expenses screen. */
  link?: { href: string; label: string };
  /** Payment method or provider, for the logo and the filter. */
  method: string;
  status?: string;
  title: string;
};

export type StatementFilter = {
  direction: "" | "in" | "out";
  /** `YYYY-MM-DD`, Nepal days. */
  from: string;
  method: string;
  min: string;
  query: string;
  status: string;
  to: string;
};

export const NO_FILTER: StatementFilter = { direction: "", from: "", method: "", min: "", query: "", status: "", to: "" };

export const QUICK_RANGES = [7, 14, 30] as const;

const NEPAL_OFFSET_MS = 345 * 60_000;

/** The Nepal calendar day an instant falls on, as `YYYY-MM-DD`. */
export function nepalDay(at: string | Date) {
  return new Date(new Date(at).getTime() + NEPAL_OFFSET_MS).toISOString().slice(0, 10);
}

export function quickRange(days: number, now = new Date()) {
  return { from: nepalDay(new Date(now.getTime() - (days - 1) * 86_400_000)), to: nepalDay(now) };
}

export function activeQuickRange(filter: StatementFilter, now = new Date()) {
  return QUICK_RANGES.find((days) => {
    const range = quickRange(days, now);
    return filter.from === range.from && filter.to === range.to;
  });
}

/** Filters set apart from the search box — what the badge on the filter button counts. */
export function activeFilterCount(filter: StatementFilter) {
  return [filter.direction, filter.from || filter.to, filter.method, filter.status, filter.min].filter(Boolean).length;
}

const signed = (row: StatementRow) => (row.kind === "in" ? row.amount : row.kind === "out" ? -row.amount : 0);

/**
 * Newest first, each row carrying the balance after it — counted oldest first
 * from `opening`. A row with no date sorts last and gets no balance, since
 * nobody can say where in the running total it belongs.
 */
export function withBalances(rows: StatementRow[], opening = 0): StatementRow[] {
  const dated = rows.filter((row) => row.at).sort((left, right) => left.at!.localeCompare(right.at!));
  let balance = opening;
  const out = dated.map((row) => {
    balance += signed(row);
    return { ...row, balance };
  });

  return [...out.reverse(), ...rows.filter((row) => !row.at).map((row) => ({ ...row, balance: null }))];
}

export function filterRows(rows: StatementRow[], filter: StatementFilter) {
  const term = filter.query.trim().toLowerCase();
  const min = Number(filter.min) || 0;

  return rows.filter((row) => {
    const day = row.at ? nepalDay(row.at) : "";

    return (
      (!filter.direction || row.kind === filter.direction) &&
      (!filter.method || row.method === filter.method) &&
      (!filter.status || row.status === filter.status) &&
      (!filter.from || (day && day >= filter.from)) &&
      (!filter.to || (day && day <= filter.to)) &&
      row.amount >= min &&
      (!term || [row.title, ...row.facts.map(([, value]) => value)].join(" ").toLowerCase().includes(term))
    );
  });
}

/** Days newest first, each with its rows and its net (in minus out). */
export function groupByDay(rows: StatementRow[]) {
  const days = new Map<string, { key: string; label: string; net: number; rows: StatementRow[] }>();

  for (const row of rows) {
    const key = row.at ? nepalDay(row.at) : "undated";
    const day = days.get(key) ?? { key, label: row.at ? formatHostelDate(row.at) : "Date not recorded", net: 0, rows: [] };

    day.rows.push(row);
    day.net += signed(row);
    days.set(key, day);
  }

  return [...days.values()];
}

export function totals(rows: StatementRow[]) {
  return rows.reduce(
    (sum, row) => ({
      in: sum.in + (row.kind === "in" ? row.amount : 0),
      out: sum.out + (row.kind === "out" ? row.amount : 0),
    }),
    { in: 0, out: 0 },
  );
}

export function optionsOf(rows: StatementRow[], key: "method" | "status") {
  return [...new Set(rows.map((row) => row[key]).filter((value): value is string => Boolean(value)))].sort();
}
