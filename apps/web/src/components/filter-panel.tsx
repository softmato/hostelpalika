"use client";

import type { ReactNode } from "react";

import { Glyph } from "@/components/glyph";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

/**
 * The FoneBiz filter: one "Filters" button that carries a count of what is
 * applied, opening a panel that zooms in under it. The page keeps its search
 * box; everything else that narrows the list lives in here, as chips.
 */
export function FilterButton({
  active,
  children,
  onClear,
}: {
  /** How many filters are applied — shown on the button, hidden at zero. */
  active: number;
  children: ReactNode;
  onClear?: () => void;
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button className="h-10 gap-2 rounded-xl" type="button" variant="outline">
          <Glyph className="size-4" name="filter" variant={active > 0 ? "solid" : "line"} />
          Filters
          {active > 0 ? (
            <span
              className="flex h-5 min-w-5 items-center justify-center rounded-full bg-brand-teal px-1.5 text-[11px] font-bold text-white animate-in zoom-in-50"
              key={active}
            >
              {active}
            </span>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-4 rounded-2xl p-4 data-open:slide-in-from-top-2">
        {children}
        {onClear ? (
          <div className="flex justify-end border-t border-border/70 pt-3">
            <button
              className="text-[12.5px] font-semibold text-role-team disabled:text-muted-foreground"
              disabled={active === 0}
              onClick={onClear}
              type="button"
            >
              Clear filters
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

/** One filter inside the panel: a label and a row of choice chips. */
export function FilterChoice<T extends string>({
  label,
  onChange,
  options,
  value,
}: {
  label: string;
  onChange: (value: T) => void;
  options: { label: string; value: T }[];
  value: T;
}) {
  return (
    <div>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const on = option.value === value;

          return (
            <button
              aria-pressed={on}
              className={cn(
                "rounded-full border px-3 py-1 text-[12.5px] font-medium transition duration-150 active:scale-95",
                on
                  ? "border-transparent bg-foreground text-background"
                  : "border-border text-muted-foreground hover:border-foreground/30 hover:text-foreground",
              )}
              key={option.value}
              onClick={() => onChange(option.value)}
              type="button"
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
