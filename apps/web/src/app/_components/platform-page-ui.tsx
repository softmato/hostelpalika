"use client";

import type { ReactNode } from "react";

import { Glyph, type GlyphName } from "@/components/glyph";
import { MoreHorizontal } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * The platform pages' small pictures, set by Rooms & Beds (docs/DESIGN.md →
 * "Portal page patterns"): a share is a thin bar, a fact is a chip, and header
 * actions past the third live in a ⋯ menu.
 */

/** `part` of `total` as a bar, with the count and percent above it. */
export function ShareBar({
  label,
  part,
  tone = "brand",
  total,
}: {
  label: string;
  part: number;
  tone?: "brand" | "amber" | "rose";
  total: number;
}) {
  const share = total > 0 ? Math.min(100, Math.round((part / total) * 100)) : 0;

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-[12.5px]">
        <span className="truncate font-semibold text-foreground">
          {part.toLocaleString()}
          <span className="font-normal text-muted-foreground"> / {total.toLocaleString()} {label}</span>
        </span>
        <span className="font-semibold text-muted-foreground">{share}%</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-700 ease-out",
            tone === "amber" ? "bg-amber-500" : tone === "rose" ? "bg-rose-500" : "bg-brand-teal",
          )}
          style={{ width: `${share}%` }}
        />
      </div>
    </div>
  );
}

/** One fact as a chip with its glyph — neutral, or amber/rose when it is a warning. */
export function FactChip({
  children,
  glyph,
  tone = "neutral",
}: {
  children: ReactNode;
  glyph?: GlyphName;
  tone?: "neutral" | "brand" | "amber" | "rose";
}) {
  return (
    <span
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full px-2.5 py-1 text-[12px] font-medium",
        tone === "brand" && "bg-role-team-soft text-role-team",
        tone === "amber" && "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
        tone === "rose" && "bg-rose-50 text-rose-700 dark:bg-rose-950/40 dark:text-rose-300",
        tone === "neutral" && "bg-muted text-foreground",
      )}
    >
      {glyph ? <Glyph className="size-3.5 shrink-0" name={glyph} /> : null}
      <span className="truncate">{children}</span>
    </span>
  );
}

/** The header's ⋯ menu, or a row's (`row`). Children are `DropdownMenuItem`s. */
export function MoreMenu({
  children,
  label = "More actions",
  row = false,
}: {
  children: ReactNode;
  label?: string;
  row?: boolean;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          aria-label={label}
          className={row ? "size-8 rounded-lg" : "size-9 rounded-xl"}
          onClick={(event) => event.stopPropagation()}
          size="icon"
          type="button"
          variant={row ? "ghost" : "outline"}
        >
          <MoreHorizontal className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
