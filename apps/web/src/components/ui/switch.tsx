"use client";

import { cn } from "@/lib/utils";

/** An on/off switch — the app sheet's toggle on the web. */
export function Switch({
  checked,
  className,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  className?: string;
  disabled?: boolean;
  /** Read by screen readers; the visible label sits beside it. */
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      aria-checked={checked}
      aria-label={label}
      className={cn(
        "relative h-6 w-11 shrink-0 rounded-full transition-colors duration-200 disabled:opacity-50",
        checked ? "bg-brand-teal" : "bg-muted-foreground/30",
        className,
      )}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      role="switch"
      type="button"
    >
      <span
        className={cn(
          "absolute top-0.5 size-5 rounded-full bg-white shadow transition-[left] duration-200",
          checked ? "left-[22px]" : "left-0.5",
        )}
      />
    </button>
  );
}
