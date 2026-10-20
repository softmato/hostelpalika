"use client";

import { formatHostelTime } from "@hostel/shared/calendar/bs";
import { BarChart3, ChevronDown, ChevronRight, ChevronUp, Download, SlidersHorizontal, X } from "@/components/icons";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";

import { currency } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { WalletMark } from "@/components/wallet-mark";
import {
  activeFilterCount,
  activeQuickRange,
  filterRows,
  groupByDay,
  NO_FILTER,
  optionsOf,
  QUICK_RANGES,
  quickRange,
  type StatementFilter,
  type StatementRow,
  totals,
} from "@/lib/statement";
import type { TableFormat } from "@/lib/downloads/downloader";
import { cn } from "@/lib/utils";

/**
 * A statement laid out the way the app lays it (`manage/finance/statement`,
 * `(resident)/statement`): a painted bar with the summary card riding its
 * bottom edge, search beside a filter button, the quick ranges behind a pill
 * on the hairline, days as headings outside the cards with the day's total,
 * one card per movement with its wallet mark and the balance after it, and a
 * detail sheet. The colour is ours — the brand green, never a reference's.
 */

function humanize(value: string) {
  return value
    .toLowerCase()
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function Chip({ label, onClick, selected }: { label: ReactNode; onClick: () => void; selected: boolean }) {
  return (
    <button
      aria-pressed={selected}
      className={cn(
        "inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition",
        selected ? "border-brand-teal bg-brand-teal text-white" : "border-border bg-card text-foreground hover:bg-muted",
      )}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

function ChipGroup({
  label,
  onChange,
  options,
  render = humanize,
  value,
}: {
  label: string;
  onChange: (value: string) => void;
  options: string[];
  render?: (value: string) => ReactNode;
  value: string;
}) {
  return (
    <div className="space-y-2">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        <Chip label="All" onClick={() => onChange("")} selected={value === ""} />
        {options.map((option) => (
          <Chip key={option} label={render(option)} onClick={() => onChange(option)} selected={value === option} />
        ))}
      </div>
    </div>
  );
}

export function StatementView({
  balanceLabel,
  error,
  exportAction,
  loading,
  mixed,
  overviewHref,
  rows,
  subtitle,
  title = "Statement",
}: {
  /** "Balance" when money goes both ways, "Total paid" on a resident's own. */
  balanceLabel: string;
  error?: string | null;
  /** The bar's export button — given the rows on screen. */
  exportAction?: (rows: StatementRow[]) => ReactNode;
  loading: boolean;
  /** The list holds money out as well as in. */
  mixed: boolean;
  /** Where the summary card leads. */
  overviewHref?: string;
  /** Newest first, balances set (`withBalances`). */
  rows: StatementRow[];
  subtitle: string;
  title?: string;
}) {
  const [filter, setFilter] = useState<StatementFilter>(NO_FILTER);
  const [draft, setDraft] = useState<StatementFilter>(NO_FILTER);
  const [filterOpen, setFilterOpen] = useState(false);
  const [rangesOpen, setRangesOpen] = useState(false);
  const [open, setOpen] = useState<StatementRow | null>(null);

  const visible = useMemo(() => filterRows(rows, filter), [filter, rows]);
  const days = useMemo(() => groupByDay(visible), [visible]);
  const methods = useMemo(() => optionsOf(rows, "method"), [rows]);
  const statuses = useMemo(() => optionsOf(rows, "status"), [rows]);
  const filterCount = activeFilterCount(filter);
  const activeRange = activeQuickRange(filter);
  // The headline is this month (30 days) over everything, not the filtered list.
  const month = useMemo(() => totals(filterRows(rows, { ...NO_FILTER, ...quickRange(30) })), [rows]);
  const shown = totals(visible);
  const clear = () => setFilter((current) => ({ ...NO_FILTER, query: current.query }));

  return (
    <div className="mx-auto max-w-3xl">
      {/* The painted bar, rounded at the bottom, with the summary card on its edge. */}
      <div className="rounded-b-[28px] rounded-t-2xl bg-brand-teal px-5 pb-12 pt-5 text-white sm:px-6">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <h1 className="font-heading text-2xl font-bold tracking-tight">{title}</h1>
            <p className="text-sm text-white/80">{subtitle}</p>
          </div>
          {exportAction ? exportAction(visible) : null}
        </div>
      </div>

      <div className="-mt-8 px-3 sm:px-5">
        <Link
          className="flex items-center gap-3 rounded-2xl border border-border bg-card p-3.5 shadow-lg transition hover:bg-muted/40"
          href={overviewHref ?? "#"}
        >
          <span className="flex size-10 items-center justify-center rounded-2xl bg-brand-teal/10 text-brand-teal">
            <BarChart3 className="size-[18px]" />
          </span>
          <span className="min-w-0 flex-1">
            {loading ? (
              <span className="block space-y-1.5">
                <span className="block h-3.5 w-3/4 animate-pulse rounded bg-muted" />
                <span className="block h-2.5 w-1/2 animate-pulse rounded bg-muted" />
              </span>
            ) : mixed ? (
              <>
                <span className="block truncate text-sm font-semibold text-foreground">
                  {currency(month.in)} in · {currency(month.out)} out
                </span>
                <span className="block truncate text-xs text-muted-foreground">Last 30 days · Net {currency(month.in - month.out)}</span>
              </>
            ) : (
              <>
                <span className="block truncate text-sm font-semibold text-foreground">{currency(month.in + month.out)} paid in the last 30 days</span>
                <span className="block truncate text-xs text-muted-foreground">
                  {rows.length === 1 ? "1 payment" : `${rows.length} payments`} in all
                </span>
              </>
            )}
          </span>
          {overviewHref ? <ChevronRight className="size-[18px] text-muted-foreground" /> : null}
        </Link>
      </div>

      {/* Search, then the filter button — the reference's hairline between them. */}
      <div className="space-y-3 px-3 pb-3 pt-4 sm:px-5">
        <div className="flex items-center gap-2">
          <label className="flex h-11 flex-1 items-center gap-2 rounded-2xl border border-border bg-card px-3.5">
            <input
              className="h-full flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              onChange={(event) => setFilter((current) => ({ ...current, query: event.target.value }))}
              placeholder="Search this statement"
              value={filter.query}
            />
            {filter.query ? (
              <button aria-label="Clear search" onClick={() => setFilter((current) => ({ ...current, query: "" }))} type="button">
                <X className="size-4 text-muted-foreground" />
              </button>
            ) : null}
          </label>
          <span className="h-6 w-px bg-border" />
          <button
            aria-label={filterCount ? `Filter the statement, ${filterCount} on` : "Filter the statement"}
            className="relative flex size-10 items-center justify-center rounded-full transition hover:bg-muted"
            onClick={() => {
              setDraft(filter);
              setFilterOpen(true);
            }}
            type="button"
          >
            <SlidersHorizontal className="size-5 text-foreground" />
            {filterCount ? (
              <span className="absolute -right-0.5 -top-0.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-brand-teal px-1 text-[10px] font-bold text-white">
                {filterCount}
              </span>
            ) : null}
          </button>
        </div>

        {rangesOpen ? (
          <div className="flex flex-wrap items-center gap-2">
            {QUICK_RANGES.map((daysBack) => (
              <Chip
                key={daysBack}
                label={`${daysBack} days`}
                onClick={() => setFilter((current) => ({ ...current, ...quickRange(daysBack) }))}
                selected={activeRange === daysBack}
              />
            ))}
            {filterCount ? (
              <button className="text-xs font-semibold text-brand-teal hover:underline" onClick={clear} type="button">
                Clear filters
              </button>
            ) : null}
          </div>
        ) : filterCount ? (
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span>{filterCount === 1 ? "1 filter on" : `${filterCount} filters on`}</span>
            <button className="font-semibold text-brand-teal hover:underline" onClick={clear} type="button">
              Clear filters
            </button>
          </div>
        ) : null}
      </div>

      <div className="h-px bg-border" />
      {/* The pill that straddles the hairline and opens the quick ranges. */}
      <div className="-mt-[15px] flex justify-center">
        <button
          aria-label={rangesOpen ? "Hide the quick ranges" : "Show the quick ranges"}
          className="flex size-[30px] items-center justify-center rounded-full bg-brand-teal text-white shadow transition hover:opacity-90"
          onClick={() => setRangesOpen((value) => !value)}
          type="button"
        >
          {rangesOpen ? <ChevronUp className="size-4" /> : <ChevronDown className="size-4" />}
        </button>
      </div>

      <div className="space-y-5 px-3 pb-10 pt-4 sm:px-5">
        {loading ? (
          <div className="space-y-3">
            {[0, 1, 2, 3].map((index) => (
              <div className="h-28 animate-pulse rounded-2xl bg-muted" key={index} />
            ))}
          </div>
        ) : error ? (
          <p className="rounded-2xl border border-border bg-card p-6 text-center text-sm text-muted-foreground">{error}</p>
        ) : null}

        {!loading && !error && filterCount > 0 && visible.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {mixed
              ? `${currency(shown.in)} in · ${currency(shown.out)} out · Net ${currency(shown.in - shown.out)}`
              : `${visible.length === 1 ? "1 payment" : `${visible.length} payments`} · ${currency(shown.in + shown.out)}`}
          </p>
        ) : null}

        {!loading && !error && visible.length === 0 ? (
          <div className="space-y-3 rounded-2xl border border-border bg-card p-6 text-center">
            <p className="font-semibold text-foreground">{filterCount || filter.query ? "Nothing here" : "Nothing has moved yet"}</p>
            <p className="text-sm text-muted-foreground">
              {filterCount || filter.query
                ? "Nothing in the statement matches what you asked for."
                : mixed
                  ? "Every payment a resident makes, and every expense you record, lands here."
                  : "Every payment you make lands here the moment it is recorded."}
            </p>
            {filterCount ? (
              <Button onClick={clear} size="sm" variant="outline">
                Clear filters
              </Button>
            ) : null}
          </div>
        ) : null}

        {days.map((day) => (
          <section className="space-y-3" key={day.key}>
            <div className="flex items-end justify-between gap-3 px-1">
              <p className="truncate text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{day.label}</p>
              <p className="text-xs font-semibold text-muted-foreground">{currency(Math.abs(day.net))}</p>
            </div>
            {day.rows.map((row) => {
              const out = row.kind === "out";

              return (
                <button
                  className="block w-full rounded-2xl border border-border bg-card p-4 text-left transition hover:border-brand-teal/40 hover:shadow-sm"
                  key={row.id}
                  onClick={() => setOpen(row)}
                  type="button"
                >
                  <div className="flex items-start gap-3">
                    <WalletMark name={row.method} size={40} />
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="line-clamp-2 text-sm font-semibold text-foreground">{row.title}</p>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-xs text-muted-foreground">{row.at ? formatHostelTime(row.at) : "—"}</span>
                        {row.badges?.map((badge) => (
                          <span
                            className={cn(
                              "rounded-full px-2 py-0.5 text-[11px] font-semibold",
                              badge === "Part payment" ? "bg-warning/10 text-warning" : "bg-muted text-muted-foreground",
                            )}
                            key={badge}
                          >
                            {badge}
                          </span>
                        ))}
                      </div>
                    </div>
                    <p
                      className={cn(
                        "flex shrink-0 items-center gap-1 pt-0.5 text-sm font-bold tabular-nums",
                        row.kind === "move" ? "text-muted-foreground" : out ? "text-destructive" : "text-success",
                      )}
                    >
                      <span aria-hidden className="text-[10px]">
                        {row.kind === "move" ? "⇄" : out ? "▼" : "▲"}
                      </span>
                      {currency(row.amount)}
                    </p>
                  </div>
                  <div className="mt-3 flex items-end justify-between gap-3 border-t border-border pt-3">
                    <span>
                      <span className="block text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{balanceLabel}</span>
                      <span className="text-sm font-semibold text-foreground">
                        {row.balance == null ? "—" : currency(row.balance)}
                      </span>
                    </span>
                    {row.link ? (
                      <span className="rounded-lg bg-brand-teal/10 px-3 py-1.5 text-[11px] font-bold uppercase tracking-wide text-brand-teal">
                        {row.link.label}
                      </span>
                    ) : null}
                  </div>
                </button>
              );
            })}
          </section>
        ))}
      </div>

      {/* The detail — a label/value grid, as the app's sheet. */}
      <Sheet onOpenChange={(next) => (next ? null : setOpen(null))} open={open !== null}>
        <SheetContent className="w-full sm:max-w-md">
          {open ? (
            <>
              <SheetHeader>
                <div className="flex items-center gap-3">
                  <WalletMark name={open.method} size={44} />
                  <div className="min-w-0">
                    <SheetTitle className="line-clamp-2">{open.title}</SheetTitle>
                    <SheetDescription>
                      {open.kind === "out" ? "Money out" : open.kind === "move" ? "Handed to staff — not spending" : "Money in"}
                    </SheetDescription>
                  </div>
                </div>
              </SheetHeader>
              <dl className="divide-y divide-border px-4">
                {open.facts.map(([label, value]) => (
                  <div className="flex justify-between gap-4 py-2.5 text-sm" key={label}>
                    <dt className="text-muted-foreground">{label}</dt>
                    <dd className="text-right font-medium text-foreground">{value}</dd>
                  </div>
                ))}
                {open.balance != null ? (
                  <div className="flex justify-between gap-4 py-2.5 text-sm">
                    <dt className="text-muted-foreground">{balanceLabel}</dt>
                    <dd className="text-right font-medium text-foreground">{currency(open.balance)}</dd>
                  </div>
                ) : null}
              </dl>
              <SheetFooter>
                {open.link ? (
                  <Button asChild variant="outline">
                    <Link href={open.link.href}>Open {open.link.label.toLowerCase()}</Link>
                  </Button>
                ) : null}
                <Button onClick={() => setOpen(null)}>Done</Button>
              </SheetFooter>
            </>
          ) : null}
        </SheetContent>
      </Sheet>

      {/* The filter — chip groups with Reset and Apply; nothing moves until Apply. */}
      <Sheet onOpenChange={setFilterOpen} open={filterOpen}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-md">
          <SheetHeader>
            <SheetTitle>Statement filter</SheetTitle>
            <SheetDescription>Pick what to show, then apply.</SheetDescription>
          </SheetHeader>
          <div className="space-y-5 px-4">
            {mixed ? (
              <ChipGroup
                label="Money"
                onChange={(value) => setDraft((current) => ({ ...current, direction: value as StatementFilter["direction"] }))}
                options={["in", "out"]}
                render={(value) => (value === "in" ? "Money in" : "Money out")}
                value={draft.direction}
              />
            ) : null}
            {statuses.length > 1 ? (
              <ChipGroup
                label="Status"
                onChange={(value) => setDraft((current) => ({ ...current, status: value }))}
                options={statuses}
                value={draft.status}
              />
            ) : null}
            {methods.length > 1 ? (
              <ChipGroup
                label="How it moved"
                onChange={(value) => setDraft((current) => ({ ...current, method: value }))}
                options={methods}
                value={draft.method}
              />
            ) : null}
            <div className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Dates</p>
              <div className="grid grid-cols-2 gap-2">
                <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
                  From
                  <input
                    className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-brand-teal"
                    onChange={(event) => setDraft((current) => ({ ...current, from: event.target.value }))}
                    type="date"
                    value={draft.from}
                  />
                </label>
                <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
                  To
                  <input
                    className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-brand-teal"
                    onChange={(event) => setDraft((current) => ({ ...current, to: event.target.value }))}
                    type="date"
                    value={draft.to}
                  />
                </label>
              </div>
              <Chip label="All time" onClick={() => setDraft((current) => ({ ...current, from: "", to: "" }))} selected={!draft.from && !draft.to} />
            </div>
            <label className="grid gap-1 text-xs font-semibold text-muted-foreground">
              At least (NPR)
              <input
                className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground outline-none focus:border-brand-teal"
                inputMode="numeric"
                onChange={(event) => setDraft((current) => ({ ...current, min: event.target.value.replace(/\D/g, "") }))}
                placeholder="0"
                value={draft.min}
              />
            </label>
          </div>
          <SheetFooter className="flex-row gap-2">
            <Button className="flex-1" onClick={() => setDraft({ ...NO_FILTER, query: draft.query })} variant="ghost">
              Reset
            </Button>
            <Button
              className="flex-1"
              onClick={() => {
                setFilter(draft);
                setFilterOpen(false);
              }}
            >
              Apply
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** The bar's export control, white on the paint: a PDF to hand on, or a spreadsheet to reconcile. */
export function StatementExportButton({
  disabled,
  onExport,
}: {
  disabled?: boolean;
  onExport: (format: TableFormat) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          aria-label="Export this statement"
          className="flex size-10 items-center justify-center rounded-full bg-white/15 text-white transition hover:bg-white/25 disabled:opacity-50"
          disabled={disabled}
          type="button"
        >
          <Download className="size-5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem onSelect={() => onExport("pdf")}>
          <span className="grid">
            <span className="font-semibold">PDF</span>
            <span className="text-xs text-muted-foreground">Laid out to read, print or send on</span>
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onExport("csv")}>
          <span className="grid">
            <span className="font-semibold">Spreadsheet</span>
            <span className="text-xs text-muted-foreground">A CSV your accountant can open in Excel</span>
          </span>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
