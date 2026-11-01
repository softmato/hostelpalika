"use client";

import dynamic from "next/dynamic";
import type { ReactNode } from "react";

import { MetricCard } from "@/app/_components/portal-dashboard-ui";
import { currency, EmptyState } from "@/app/_components/shared-ui";
import type { GlyphName } from "@/components/glyph";
import type { IconComponent } from "@/components/icons";
import { formatBsPeriodMonth } from "@/lib/hostel-day";

export type CountMap = Record<string, number>;

const statTones = {
  bad: { note: "rose", tone: "rose" },
  default: { note: "slate", tone: "teal" },
  good: { note: "green", tone: "green" },
  warn: { note: "amber", tone: "amber" },
} as const;

/** Single headline figure with an optional caption underneath: a `MetricCard`. */
export function StatTile({
  hint,
  icon,
  label,
  tone = "default",
  value,
}: {
  hint?: string;
  icon?: IconComponent;
  label: string;
  tone?: "default" | "good" | "warn" | "bad";
  value: ReactNode;
}) {
  return (
    <MetricCard
      icon={icon}
      label={label}
      note={hint}
      noteTone={statTones[tone].note}
      tone={statTones[tone].tone}
      value={value}
    />
  );
}

const SEGMENT_COLORS = ["#0a8a4b", "#f59e0b", "#6366f1", "#f43f5e", "#94a3b8"];
const SEGMENTS_SHOWN = 4;

/**
 * A `{ STATUS: count }` breakdown as one stacked bar with a short legend, in
 * place of a bar per row: the same figures in a fifth of the height. The biggest
 * few get a colour each; the long tail is folded into "Other".
 */
export function Breakdown({
  emptyLabel = "No data yet.",
  glyph,
  map,
  total,
}: {
  emptyLabel?: string;
  /** The empty state's own icon, so each section's empty card is told apart. */
  glyph?: GlyphName;
  map: CountMap;
  total?: number;
}) {
  const sorted = Object.entries(map ?? {})
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1]);

  if (sorted.length === 0) {
    return <EmptyState glyph={glyph} label={emptyLabel} />;
  }

  const entries: Array<[string, number]> =
    sorted.length > SEGMENTS_SHOWN + 1
      ? [
          ...sorted.slice(0, SEGMENTS_SHOWN),
          ["Other", sorted.slice(SEGMENTS_SHOWN).reduce((sum, [, count]) => sum + count, 0)],
        ]
      : sorted;
  const sum = total ?? entries.reduce((acc, [, count]) => acc + count, 0);

  return (
    <div>
      <div className="flex h-2 gap-0.5 overflow-hidden rounded-full bg-muted">
        {entries.map(([label, count], index) => (
          <div
            key={label}
            style={{ background: SEGMENT_COLORS[index % SEGMENT_COLORS.length], width: `${(count / sum) * 100}%` }}
            title={`${label.replaceAll("_", " ")}: ${count}`}
          />
        ))}
      </div>
      <ul className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1">
        {entries.map(([label, count], index) => (
          <li className="flex items-center gap-1.5 text-xs text-muted-foreground" key={label}>
            <span className="size-2 rounded-full" style={{ background: SEGMENT_COLORS[index % SEGMENT_COLORS.length] }} />
            <span className="capitalize">{label.replaceAll("_", " ").toLowerCase()}</span>
            <span className="font-semibold tabular-nums text-foreground">{count.toLocaleString()}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type MonthlyPoint = {
  collectionRate: number;
  due: number;
  month: string;
  outstanding: number;
  paid: number;
  residents: number;
};

/**
 * An axis tick — `Bhadra`, the month alone.
 *
 * ## Why the private copy went
 *
 * This built a `Date` out of the two halves of the period key and asked it for
 * an English short month. That was right while a period was Gregorian and became
 * silently wrong the day it stopped being one: `2083-05` fed to `Date.UTC` is
 * May of the year 2083, so the collection chart labelled Bhadra's bar **May**,
 * Aswin's **Jun**, and so on down the axis — six wrong month names under
 * correct-looking bars, which is worse than no labels at all.
 *
 * The fix is not a corrected local copy. A second answer to "what is this month
 * called" living beside `lib/format-month` is what produced the divergence, so
 * the name now comes from the shared calendar like everywhere else.
 *
 * ## The month alone, not abbreviated
 *
 * An axis carries the **lead** calendar and drops the translation — there is no
 * room for both under a bar. Not shortened to three letters: `Bhadra` and
 * `Baisakh` collide at `Bha`/`Bai`, as do `Mangsir` and `Magh`, so three
 * characters do not separate the Nepali months the way they separate the English
 * ones. The year is not repeated per bar; the chart covers one run of months and
 * the tooltip carries the full label.
 *
 * A pre-cutover Gregorian key keeps the English short month it always had.
 */
function axisMonth(month: string) {
  const bs = formatBsPeriodMonth(month);

  if (bs) {
    return bs;
  }

  const [year, index] = month.split("-");
  const date = new Date(Date.UTC(Number(year), Number(index) - 1, 1));

  return Number.isNaN(date.getTime())
    ? month
    : date.toLocaleString("en", { month: "short", timeZone: "UTC" });
}

/**
 * Due-vs-collected per month, straight off the payment ledger, as a bar or a line chart.
 */
const ReportBarLineChart = dynamic(() => import("@/components/report-bar-line-chart"), {
  loading: () => <div className="h-[340px] w-full animate-pulse rounded-xl bg-muted" />,
  ssr: false,
});

export function CollectionChart({ points }: { points: MonthlyPoint[] }) {
  return (
    <ReportBarLineChart
      points={points.map((point) => ({
        billed: point.due,
        collected: point.paid,
        label: axisMonth(point.month),
      }))}
    />
  );
}

/** Compact table used for the recent-payments ledger extract. */
export function DataTable({
  columns,
  emptyLabel,
  rows,
}: {
  columns: string[];
  emptyLabel: string;
  rows: ReactNode[][];
}) {
  if (rows.length === 0) {
    return <EmptyState label={emptyLabel} />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-border">
            {columns.map((column) => (
              <th
                className="pb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground"
                key={column}
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr className="border-b border-border/60 last:border-0" key={index}>
              {row.map((cell, cellIndex) => (
                <td className="py-2.5 pr-3 text-foreground" key={cellIndex}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function money(value: number) {
  return currency(value);
}
