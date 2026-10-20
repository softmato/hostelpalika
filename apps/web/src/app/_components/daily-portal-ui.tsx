"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { currency } from "@/app/_components/shared-ui";
import { Glyph, type GlyphName } from "@/components/glyph";
import { dayMonthYear, dayMonthYearBs, daysLeftLabel } from "@/lib/format-month";
import { cn } from "@/lib/utils";

/*
 * The pictures the resident, guardian, cook, provider and team portals share:
 * a figure with a bar to its due date, meals as tiles, notices as cards. These
 * portals are for residents, parents, cooks and agents, so they lean on big
 * numbers and marks rather than tables.
 */

export const MEAL_GLYPH: Record<string, GlyphName> = {
  BREAKFAST: "cafe",
  DINNER: "bowl",
  LUNCH: "restaurant",
  SNACKS: "cookie",
};

export function titleCase(value: string) {
  const words = value.replaceAll("_", " ").toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** A small fact with its mark: "3 rooms", "Twin sharing", a phone number. */
export function FactChip({
  children,
  glyph,
  href,
  tone = "neutral",
}: {
  children: ReactNode;
  glyph: GlyphName;
  href?: string;
  tone?: "neutral" | "brand" | "warn" | "wrong";
}) {
  const className = cn(
    "inline-flex min-w-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium",
    tone === "brand" && "bg-role-team-soft text-role-team",
    tone === "warn" && "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
    tone === "wrong" && "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
    tone === "neutral" && "bg-muted text-foreground",
    href && "transition hover:bg-foreground/10",
  );
  const inner = (
    <>
      <Glyph className="size-3.5 shrink-0" name={glyph} />
      <span className="truncate">{children}</span>
    </>
  );

  if (!href) return <span className={className}>{inner}</span>;

  return href.startsWith("/") ? (
    <Link className={className} href={href}>
      {inner}
    </Link>
  ) : (
    <a className={className} href={href}>
      {inner}
    </a>
  );
}

/** A share as a thin bar: beds taken, months settled, rupees received. */
export function ShareBar({
  className,
  label,
  total,
  tone = "brand",
  value,
}: {
  className?: string;
  label?: ReactNode;
  total: number;
  tone?: "brand" | "warn" | "wrong";
  value: number;
}) {
  const share = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;

  return (
    <div className={cn("space-y-1.5", className)}>
      {label ? (
        <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
          <span className="min-w-0 truncate text-muted-foreground">{label}</span>
          <span className="font-semibold text-muted-foreground">{share}%</span>
        </div>
      ) : null}
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-700 ease-out",
            tone === "brand" && "bg-brand-teal",
            tone === "warn" && "bg-amber-500",
            tone === "wrong" && "bg-rose-500",
          )}
          style={{ width: `${share}%` }}
        />
      </div>
    </div>
  );
}

/** Whole days from today to `value`, both at local midnight; negative once past. */
export function daysUntil(value: string | null | undefined): number | null {
  if (!value) return null;
  const target = new Date(value);

  if (Number.isNaN(target.getTime())) return null;
  const today = new Date();

  today.setHours(0, 0, 0, 0);
  target.setHours(0, 0, 0, 0);

  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

/** The month before a due date, as a bar that fills as the day comes. */
export function DueBar({ dueDate }: { dueDate: string | null | undefined }) {
  const days = daysUntil(dueDate);

  if (days === null) return null;
  const window = 30;
  const elapsed = Math.min(window, Math.max(0, window - days));
  const tone = days < 0 ? "wrong" : days <= 3 ? "warn" : "brand";

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
        <span
          className={cn(
            "font-semibold",
            tone === "wrong" ? "text-rose-600" : tone === "warn" ? "text-amber-600" : "text-foreground",
          )}
        >
          {daysLeftLabel(dueDate)}
        </span>
        <span className="text-muted-foreground">
          Due {dayMonthYearBs(dueDate) || dayMonthYear(dueDate)}
        </span>
      </div>
      <ShareBar tone={tone} total={window} value={elapsed} />
    </div>
  );
}

/** The amount owed, large, with its due date as a bar under it. */
export function AmountCard({
  amount,
  children,
  dueDate,
  label = "Amount due",
  note,
}: {
  amount: number;
  children?: ReactNode;
  dueDate?: string | null;
  label?: string;
  note?: ReactNode;
}) {
  const clear = amount <= 0;

  return (
    <section className="flex flex-col gap-4 rounded-2xl border border-border/70 bg-card p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
          <p className="mt-1 font-heading text-[34px] font-bold leading-none tracking-tight text-foreground tabular-nums">
            {currency(amount)}
          </p>
          {note ? <div className="mt-2 text-[12.5px] text-muted-foreground">{note}</div> : null}
        </div>
        <span
          className={cn(
            "flex size-11 shrink-0 items-center justify-center rounded-2xl",
            clear ? "bg-role-team-soft text-role-team" : "bg-foreground text-background",
          )}
        >
          <Glyph className="size-[22px]" name={clear ? "checkmark-circle" : "wallet"} variant="solid" />
        </span>
      </div>
      {!clear && dueDate ? <DueBar dueDate={dueDate} /> : null}
      {children}
    </section>
  );
}

/** One meal: its mark, name, time and what is on the plate. */
export function MealTile({
  items,
  mealType,
  note,
  timing,
}: {
  items: string[];
  mealType: string;
  note?: string;
  timing?: string;
}) {
  return (
    <div className="flex flex-col gap-2.5 rounded-2xl border border-border/70 bg-card p-4 transition duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-center justify-between gap-2">
        <span className="flex size-10 items-center justify-center rounded-xl bg-role-team-soft text-role-team">
          <Glyph className="size-5" name={MEAL_GLYPH[mealType] ?? "restaurant"} />
        </span>
        {timing ? (
          <span className="rounded-full bg-muted px-2.5 py-0.5 text-[11.5px] font-semibold text-muted-foreground">
            {timing}
          </span>
        ) : null}
      </div>
      <div className="min-w-0">
        <p className="font-heading text-[15px] font-semibold text-foreground">{titleCase(mealType)}</p>
        <p className="mt-0.5 line-clamp-3 text-[13.5px] text-muted-foreground">
          {items.length > 0 ? items.join(", ") : "Not set"}
        </p>
        {note ? <p className="mt-1 truncate text-[11.5px] text-muted-foreground/80">{note}</p> : null}
      </div>
    </div>
  );
}

/** One notice as a card: a mark, the title, two lines, and its chips. */
export function NoticeCard({
  action,
  category,
  content,
  date,
  isNew = false,
  isUrgent,
  title,
}: {
  action?: ReactNode;
  category?: string;
  content: string;
  date?: string | null;
  isNew?: boolean;
  isUrgent: boolean;
  title: string;
}) {
  return (
    <article
      className={cn(
        "flex gap-3 rounded-2xl border bg-card p-4 transition duration-200 hover:-translate-y-0.5 hover:shadow-md",
        isUrgent ? "border-rose-200 dark:border-rose-900" : isNew ? "border-role-team/30" : "border-border/70",
      )}
    >
      <span
        className={cn(
          "flex size-10 shrink-0 items-center justify-center rounded-xl",
          isUrgent
            ? "bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400"
            : "bg-role-team-soft text-role-team",
        )}
      >
        <Glyph className="size-5" name={isUrgent ? "warning" : "megaphone"} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="font-heading text-[15px] font-semibold text-foreground">{title}</p>
          {action}
        </div>
        <p className="mt-0.5 line-clamp-3 whitespace-pre-line text-[13.5px] text-muted-foreground">{content}</p>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11.5px]">
          {isUrgent ? (
            <span className="rounded-full bg-rose-50 px-2 py-0.5 font-semibold text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
              Urgent
            </span>
          ) : null}
          {isNew ? (
            <span className="rounded-full bg-role-team-soft px-2 py-0.5 font-semibold text-role-team">New</span>
          ) : null}
          {category ? (
            <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-muted-foreground">
              {titleCase(category)}
            </span>
          ) : null}
          {date ? <span className="text-muted-foreground">{dayMonthYear(date)}</span> : null}
        </div>
      </div>
    </article>
  );
}

/** The hostel a page is about: its photo, name, place, and fact chips. */
export function HostelCard({
  address,
  chips,
  name,
  photoUrl,
  slug,
  verified,
}: {
  address: string;
  chips?: ReactNode;
  name: string;
  photoUrl?: string;
  slug?: string;
  verified?: boolean;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border/70 bg-card">
      <div className="grid sm:grid-cols-[200px_1fr]">
        <div className="relative h-36 bg-muted sm:h-full sm:min-h-[150px]">
          {photoUrl ? (
            <div
              aria-label={`${name} exterior`}
              className="size-full bg-cover bg-center"
              role="img"
              style={{ backgroundImage: `url("${photoUrl}")` }}
            />
          ) : (
            <span className="flex size-full items-center justify-center text-muted-foreground">
              <Glyph className="size-9" name="hostel" />
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-col justify-center gap-2.5 p-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="truncate font-heading text-[17px] font-bold tracking-tight text-foreground">{name}</h2>
              {verified ? (
                <Glyph className="size-[18px] shrink-0 text-role-team" name="shield-checkmark" variant="solid" />
              ) : null}
            </div>
            <p className="mt-0.5 flex items-center gap-1.5 text-[13px] text-muted-foreground">
              <Glyph className="size-3.5 shrink-0" name="location" />
              <span className="truncate">{address}</span>
            </p>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {chips}
            {slug ? (
              <FactChip glyph="open" href={`/hostels/${slug}`} tone="brand">
                Hostel page
              </FactChip>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

/** A menu of destinations as icon tiles. */
export function TileGrid({ items }: { items: { glyph: GlyphName; href: string; label: string }[] }) {
  return (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
      {items.map((item) => (
        <Link
          className="flex flex-col items-center gap-2 rounded-2xl border border-border/70 bg-card px-2 py-3.5 text-center transition duration-200 hover:-translate-y-0.5 hover:shadow-md"
          href={item.href}
          key={item.href}
        >
          <span className="flex size-10 items-center justify-center rounded-xl bg-role-team-soft text-role-team">
            <Glyph className="size-5" name={item.glyph} />
          </span>
          <span className="text-[12px] font-semibold text-foreground">{item.label}</span>
        </Link>
      ))}
    </div>
  );
}

/** A section heading outside its cards: 15px title, optional right-hand link. */
export function SectionTitle({ action, children }: { action?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="font-heading text-[15px] font-semibold tracking-tight text-foreground">{children}</h2>
      {action}
    </div>
  );
}

/** Loading as skeleton cards, not a spinner. */
export function CardSkeletons({ className, count = 3 }: { className?: string; count?: number }) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-3", className)}>
      {Array.from({ length: count }).map((_, index) => (
        <div className="h-28 animate-pulse rounded-2xl bg-muted" key={index} />
      ))}
    </div>
  );
}
