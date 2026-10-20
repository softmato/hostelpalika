"use client";

import type { ReactNode } from "react";

import { Glyph, type GlyphName } from "@/components/glyph";
import { MoreHorizontal } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { WalletMark } from "@/components/wallet-mark";
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

/** A money page's headline: one big figure, what it is, and how much of the whole is in. */
export function MoneyHero({
  label,
  note,
  part,
  total,
  value,
}: {
  label: string;
  note?: string;
  part?: number;
  total?: number;
  value: string;
}) {
  const share = part != null && total ? Math.min(100, Math.round((part / total) * 100)) : null;

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <p className="mt-1 font-heading text-[30px] font-bold leading-tight tracking-tight tabular-nums text-foreground">{value}</p>
      {note ? <p className="text-[12.5px] text-muted-foreground">{note}</p> : null}
      {share != null ? (
        <div className="mt-4 flex items-center gap-3">
          <div className="h-2.5 flex-1 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-brand-teal transition-[width] duration-700 ease-out" style={{ width: `${share}%` }} />
          </div>
          <span className="text-[13px] font-bold tabular-nums text-foreground">{share}%</span>
        </div>
      ) : null}
    </div>
  );
}

const SPLIT_TONES = {
  amber: "bg-amber-500",
  brand: "bg-brand-teal",
  muted: "bg-muted-foreground/40",
  rose: "bg-rose-500",
} as const;

/** Parts of one whole as a single stacked bar with a legend — paid, partial, overdue. */
export function SplitBar({
  parts,
  title,
}: {
  parts: { label: string; tone: keyof typeof SPLIT_TONES; value: number }[];
  title: string;
}) {
  const total = parts.reduce((sum, part) => sum + part.value, 0);

  return (
    <div className="rounded-2xl border border-border/70 bg-card p-5">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</p>
        <p className="text-[13px] font-bold tabular-nums text-foreground">{total.toLocaleString()}</p>
      </div>
      <div className="mt-3 flex h-3 gap-0.5 overflow-hidden rounded-full bg-muted">
        {parts.map((part) =>
          part.value > 0 ? (
            <div className={cn("h-full", SPLIT_TONES[part.tone])} key={part.label} style={{ width: `${(part.value / total) * 100}%` }} />
          ) : null,
        )}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {parts.map((part) => (
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground" key={part.label}>
            <span className={cn("size-2 rounded-full", SPLIT_TONES[part.tone])} />
            {part.label}
            <span className="font-semibold tabular-nums text-foreground">{part.value.toLocaleString()}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

/** A provider, wallet or bank as a chip: its real logo, then the words. */
export function WalletChip({ children, name }: { children: ReactNode; name: string | null | undefined }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted py-0.5 pl-0.5 pr-2.5 text-[12px] font-medium text-foreground">
      <WalletMark name={name} size={20} />
      <span className="truncate">{children}</span>
    </span>
  );
}
