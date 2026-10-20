"use client";

import type { ReactNode } from "react";

import { MetricCard } from "@/app/_components/portal-dashboard-ui";
import { currency, EmptyState } from "@/app/_components/shared-ui";
import type { IconComponent } from "@/components/icons";
import { monthLabel } from "@/lib/format-month";
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

/** Horizontal bars for a `{ STATUS: count }` breakdown. */
export function Breakdown({
  emptyLabel = "No data yet.",
  map,
  total,
}: {
  emptyLabel?: string;
  map: CountMap;
  total?: number;
}) {
  const entries = Object.entries(map ?? {}).sort((left, right) => right[1] - left[1]);

  if (entries.length === 0) {
    return <EmptyState label={emptyLabel} />;
  }

  const max = total ?? entries.reduce((sum, [, count]) => sum + count, 0) ?? 1;

  return (
    <dl className="grid gap-2.5">
      {entries.map(([label, count]) => (
        <div key={label}>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="truncate text-xs font-medium text-foreground">
              {label.replaceAll("_", " ")}
            </dt>
            <dd className="shrink-0 text-xs font-bold text-foreground">
              {count.toLocaleString()}
              <span className="ml-1.5 font-normal text-muted-foreground">
                {max > 0 ? `${Math.round((count / max) * 100)}%` : "0%"}
              </span>
            </dd>
          </div>
          <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-role-admin"
              style={{ width: max > 0 ? `${Math.max((count / max) * 100, 2)}%` : "0%" }}
            />
          </div>
        </div>
      ))}
    </dl>
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
 * Due-vs-collected columns per month, straight off the payment ledger. Bars are
 * scaled to the largest month so an empty ledger renders flat rather than broken.
 */
export function CollectionChart({ points }: { points: MonthlyPoint[] }) {
  const peak = Math.max(...points.map((point) => point.due), 1);

  return (
    <div>
      <div className="flex items-end gap-2 sm:gap-3" style={{ height: 160 }}>
        {points.map((point) => (
          <div className="flex flex-1 flex-col items-center gap-1" key={point.month}>
            <span className="text-[10px] font-semibold text-muted-foreground">
              {point.due > 0 ? `${point.collectionRate}%` : ""}
            </span>
            <div
              className="relative flex w-full items-end justify-center gap-0.5"
              style={{ height: 120 }}
              title={`${monthLabel(point.month)} — due ${point.due}, collected ${point.paid}`}
            >
              {/* A tint of the collected green with an edge: plain muted vanished on the card. */}
              <div
                className="w-1/2 rounded-t bg-role-admin/25 ring-1 ring-inset ring-role-admin/40"
                style={{ height: `${Math.max((point.due / peak) * 100, 1)}%` }}
              />
              <div
                className="w-1/2 rounded-t bg-role-admin"
                style={{ height: `${Math.max((point.paid / peak) * 100, 1)}%` }}
              />
            </div>
            <span className="text-[11px] font-medium text-muted-foreground">
              {axisMonth(point.month)}
            </span>
          </div>
        ))}
      </div>
      <div className="mt-3 flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-role-admin/25 ring-1 ring-inset ring-role-admin/40" /> Billed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-role-admin" /> Collected
        </span>
      </div>
    </div>
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
