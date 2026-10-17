"use client";

import type { ReactNode } from "react";

import { Glyph, type GlyphName } from "@/components/glyph";
import { MoreHorizontal } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The small pieces the hostel-admin pages share under docs/DESIGN.md "Portal
 * page patterns": a fact chip, a thin share bar, the header's ⋯ menu and the
 * 11px label. Kept here rather than in the portal-wide kits so this portal's
 * redesign never moves a page in another portal.
 */

export type ChipTone = "bad" | "brand" | "neutral" | "warn";

const CHIP_TONES: Record<ChipTone, string> = {
  bad: "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
  brand: "bg-role-team-soft text-role-team",
  neutral: "bg-muted text-foreground",
  warn: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
};

/** One fact as a pill: a glyph and a few words. */
export function Chip({
  children,
  className,
  glyph,
  tone = "neutral",
}: {
  children: ReactNode;
  className?: string;
  glyph?: GlyphName;
  tone?: ChipTone;
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium",
        CHIP_TONES[tone],
        className,
      )}
    >
      {glyph ? <Glyph className="size-3.5 shrink-0" name={glyph} /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** A share as a thin bar: "12 / 20 label" with the percentage on the right. */
export function ShareBar({
  label,
  tone = "brand",
  total,
  value,
}: {
  label?: string;
  tone?: "brand" | "warn";
  total: number;
  value: number;
}) {
  const share = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;

  return (
    <div className="space-y-1.5">
      {label !== undefined ? (
        <div className="flex items-baseline justify-between text-[12.5px]">
          <span className="font-semibold text-foreground">
            {value}
            <span className="font-normal text-muted-foreground">
              {" "}
              / {total}
              {label ? ` ${label}` : ""}
            </span>
          </span>
          <span className="font-semibold text-muted-foreground">{share}%</span>
        </div>
      ) : null}
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-700 ease-out",
            tone === "warn" ? "bg-amber-500" : "bg-brand-teal",
          )}
          style={{ width: `${share}%` }}
        />
      </div>
    </div>
  );
}

/** The header's "⋯" menu for every action past the first two or three. */
export function MoreMenu({ children, label = "More actions" }: { children: ReactNode; label?: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button aria-label={label} className="size-9 rounded-xl" size="icon" type="button" variant="outline">
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The 11px uppercase label over a group of chips or rows. */
export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground", className)}>
      {children}
    </p>
  );
}

/** A round tinted mark for a row or card: brand by default, amber/rose only for trouble. */
export function RowMark({ glyph, tone = "brand" }: { glyph: GlyphName; tone?: ChipTone }) {
  return (
    <span className={cn("flex size-9 shrink-0 items-center justify-center rounded-full", CHIP_TONES[tone])}>
      <Glyph className="size-[18px]" name={glyph} />
    </span>
  );
}
