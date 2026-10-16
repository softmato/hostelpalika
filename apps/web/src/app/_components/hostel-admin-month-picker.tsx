"use client";

import { CalendarDays, Check, ChevronDown } from "@/components/icons";
import { memo, useMemo, useState, type ReactNode } from "react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { dayMonthYear, monthLabel, periodKey } from "@/lib/format-month";
import { addBsMonths, bsPeriodBounds } from "@/lib/hostel-day";
import { cn } from "@/lib/utils";

export type PeriodRow = {
  collected: number;
  due: number;
  needsAttention: number;
  paid: number;
  period: string;
  total: number;
};

/**
 * One month in either picker's list.
 *
 * Shared so the two controls cannot drift into naming a month two ways. The
 * badge slot is `children` because the matrix picker has real per-month counts
 * to show and the form field has a date range instead — the row itself, its
 * label and its selected state are the same in both.
 */
function MonthOption({
  children,
  onSelect,
  period,
  selected,
}: {
  children?: ReactNode;
  onSelect: () => void;
  period: string;
  selected: boolean;
}) {
  return (
    <button
      className={cn(
        "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-2 text-left text-[13px] transition",
        selected
          ? "bg-role-admin/10 font-bold text-foreground"
          : "font-medium text-muted-foreground hover:bg-muted",
      )}
      onClick={onSelect}
      type="button"
    >
      <span className="flex items-center gap-1.5">
        {selected ? (
          <Check className="size-3.5 text-role-admin" />
        ) : (
          <span className="size-3.5" />
        )}
        {monthLabel(period)}
      </span>

      {children}
    </button>
  );
}

/**
 * The month the payments matrix is showing.
 *
 * Replaces `<input type="month">`, which was wrong here in three ways: it let
 * the owner walk back to months before the hostel existed and get an empty
 * table with no explanation, it emitted half-typed values that each cost a 422
 * (`2026-0`), and it could not answer the question the control is actually used
 * for — *which* month still needs work. A list of real months, each carrying its
 * own count of unfinished invoices, answers that at a glance.
 *
 * The list is the floor. There is no validation to bypass because a month before
 * the hostel was approved is simply not offered, which is also why there is no
 * error message to write.
 */
export const MonthPicker = memo(function MonthPicker({
  months,
  onChange,
  value,
}: {
  months: PeriodRow[];
  onChange: (period: string) => void;
  value: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = months.find((month) => month.period === value) ?? null;

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger asChild>
        <button
          aria-label="Choose month"
          className="flex h-10 items-center gap-2 rounded-xl border border-border bg-card px-3.5 text-sm font-semibold text-foreground shadow-sm transition hover:bg-muted/50"
          type="button"
        >
          <CalendarDays className="size-4 text-muted-foreground" />
          {monthLabel(value)}
          {selected && selected.needsAttention > 0 ? (
            <span className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10.5px] font-bold text-amber-800 dark:text-amber-300">
              {selected.needsAttention}
            </span>
          ) : null}
          <ChevronDown className="size-3.5 text-muted-foreground" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="end" className="w-64 p-1.5">
        <p className="px-2 py-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
          Month
        </p>
        <div className="max-h-72 overflow-y-auto">
          {months.length === 0 ? (
            <p className="px-2 py-3 text-[12px] text-muted-foreground">
              No months to show yet.
            </p>
          ) : null}
          {months.map((month) => {
            const isSelected = month.period === value;

            return (
              <MonthOption
                key={month.period}
                onSelect={() => {
                  onChange(month.period);
                  setOpen(false);
                }}
                period={month.period}
                selected={isSelected}
              >
                {/* The badge counts invoices still wanting a human — unpaid,
                    overdue, or carrying an unreviewed claim. A month with none
                    gets no badge at all rather than a grey zero, so the eye goes
                    straight to the months with work left in them. */}
                {month.needsAttention > 0 ? (
                  <span
                    className="rounded-full bg-amber-500/20 px-1.5 py-0.5 text-[10.5px] font-bold text-amber-800 dark:text-amber-300"
                    title={`${month.needsAttention} unpaid, overdue or awaiting review`}
                  >
                    {month.needsAttention}
                  </span>
                ) : month.total > 0 ? (
                  <Check className="size-3.5 text-emerald-600" />
                ) : (
                  <span className="text-[10.5px] text-muted-foreground">—</span>
                )}
              </MonthOption>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
});

/**
 * How far either way a form may bill.
 *
 * Back two years because a hostel does correct an old month. Forward two because
 * issuing next month's rent before it starts is ordinary — `period-summary`
 * makes the same allowance at the other end — and because an owner who cannot
 * reach the month they mean will pick the nearest one instead.
 */
const MONTHS_BACK = 24;
const MONTHS_AHEAD = 2;

/**
 * A month field inside a form, in the calendar this product bills in.
 *
 * ## Why `<input type="month">` had to go, and could not be patched
 *
 * The control has no Bikram Sambat mode. It is the browser's own widget, it
 * renders the host platform's Gregorian calendar, and the value it emits is a
 * Gregorian `YYYY-MM`. That string then went to the server as an
 * `Invoice.period` — which is now a **BS** month — so an owner picking
 * "September 2026" in the billing dialog was asking to bill `2026-09`: a period
 * fifty-seven years before anything the hostel has ever billed. The run came
 * back having issued nothing, and nothing on the screen said why.
 *
 * This is not a formatting problem with a formatting fix. A month input cannot
 * express Bhadra, so the input is replaced rather than relabelled.
 *
 * ## An identity, not a label
 *
 * The value posted is the period key itself. The list is built with
 * `addBsMonths`, which is the same arithmetic the server steps months with, so
 * the string in the form is the string the server keys invoices by — including
 * across a BS year end, where the month after `2083-12` is `2084-01` and not
 * `2083-13`.
 *
 * ## Why the Gregorian dates are on the row and not only the month name
 *
 * `Bhadra 2083 BS` alone asks an owner to know from memory which fortnight of
 * which English month it starts in, and the bank statement they are reconciling
 * against is in that other calendar. So each row carries the span it covers —
 * `17 Aug – 16 Sep 2026` — and the BS month leads, because the money is BS. That
 * is the same rule the mobile app follows: BS leads where a date is money, AD is
 * the translation beside it.
 *
 * A hidden input carries the value so `new FormData(form)` reads it exactly as
 * it read the input this replaces; no submit handler needed changing.
 */
export const MonthField = memo(function MonthField({
  defaultValue,
  hint,
  label,
  name,
  onChange,
  value,
}: {
  defaultValue?: string;
  /** Small helper line under the field, matching `shared-ui`'s `Input`. */
  hint?: ReactNode;
  label: ReactNode;
  name: string;
  onChange?: (period: string) => void;
  /** Controlled when given; otherwise the field keeps its own selection. */
  value?: string;
}) {
  const [open, setOpen] = useState(false);
  const [own, setOwn] = useState(() => defaultValue ?? periodKey(new Date()));
  const selected = value ?? own;

  const months = useMemo(() => {
    const current = periodKey(new Date());

    return Array.from({ length: MONTHS_BACK + MONTHS_AHEAD + 1 }, (_, offset) =>
      addBsMonths(current, MONTHS_AHEAD - offset),
    );
  }, []);

  // A month the list does not reach — a legacy Gregorian default, or one further
  // back than the window — is offered anyway rather than silently swapped for a
  // neighbour. Losing the caller's own value is worse than one extra row.
  const options = months.includes(selected) ? months : [selected, ...months];

  return (
    <div className="grid gap-2 text-sm font-semibold text-foreground">
      <span>{label}</span>
      <input name={name} type="hidden" value={selected} />

      <Popover onOpenChange={setOpen} open={open}>
        <PopoverTrigger asChild>
          <button
            className="flex h-11 items-center justify-between gap-2 rounded-md border border-border bg-background px-3 text-sm font-normal outline-none transition hover:bg-muted/40 focus:border-role-admin"
            type="button"
          >
            <span className="flex items-center gap-2">
              <CalendarDays className="size-4 text-muted-foreground" />
              {monthLabel(selected)}
            </span>
            <ChevronDown className="size-3.5 text-muted-foreground" />
          </button>
        </PopoverTrigger>

        <PopoverContent align="start" className="w-72 p-1.5">
          <p className="px-2 py-1.5 text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
            Month
          </p>
          <div className="max-h-72 overflow-y-auto">
            {options.map((period) => (
              <MonthOption
                key={period}
                onSelect={() => {
                  setOwn(period);
                  onChange?.(period);
                  setOpen(false);
                }}
                period={period}
                selected={period === selected}
              >
                <span className="text-[10.5px] font-normal text-muted-foreground">
                  {gregorianSpan(period)}
                </span>
              </MonthOption>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {hint ? (
        <span className="text-[11px] font-normal text-muted-foreground">{hint}</span>
      ) : null}
    </div>
  );
});

/**
 * `17 Aug – 16 Sep 2026` — the Gregorian days a BS month actually covers.
 *
 * Read off `bsPeriodBounds` rather than assumed: BS months run 29 to 32 days and
 * the length changes from year to year, so there is no arithmetic that gets the
 * closing day right without the table. Empty for a month the table cannot reach,
 * which drops the line rather than printing a guess beside a real one.
 */
function gregorianSpan(period: string): string {
  try {
    const { lastDay, start } = bsPeriodBounds(period);

    return `${dayMonthYear(start).replace(/ \d{4}$/, "")} – ${dayMonthYear(lastDay)}`;
  } catch {
    return "";
  }
}
