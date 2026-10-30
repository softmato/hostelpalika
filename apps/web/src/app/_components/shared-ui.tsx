"use client";

import { Glyph, type GlyphName } from "@/components/glyph";
import { RefreshCw } from "@/components/icons";
import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

export function currency(value: number) {
  return new Intl.NumberFormat("en-NP", {
    currency: "NPR",
    maximumFractionDigits: 0,
    style: "currency",
  }).format(value);
}

export function StatusBadge({ children }: { children: string }) {
  const tone =
    children.includes("PAID") ||
    children.includes("ACTIVE") ||
    children.includes("APPROVED")
      ? "border-emerald-200 bg-emerald-50 text-emerald-700"
      : children.includes("PENDING")
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : children.includes("REJECTED") || children.includes("OVERDUE")
          ? "border-rose-200 bg-rose-50 text-rose-700"
          : "border-border bg-muted text-muted-foreground";

  return (
    <span className={cn("rounded-full border px-2.5 py-1 text-xs font-semibold", tone)}>
      {children.replaceAll("_", " ")}
    </span>
  );
}

export function Panel({
  action,
  children,
  className,
  title,
}: {
  /** Right-aligned control on the title row — an export link, a refresh button. */
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl border border-border/70 bg-card p-4",
        className,
      )}
    >
      {title ? (
        <div className="mb-3.5 flex items-center justify-between gap-3">
          <h2 className="font-heading text-[15px] font-semibold tracking-tight text-foreground">
            {title}
          </h2>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Input({
  defaultValue,
  hint,
  label,
  max,
  min,
  name,
  onChange,
  placeholder,
  readOnly,
  required,
  step,
  type = "text",
  value,
}: {
  defaultValue?: string | number;
  /** Small helper line under the field — why it is locked, what format to use. */
  hint?: ReactNode;
  label: ReactNode;
  max?: string;
  min?: string;
  name: string;
  onChange?: (event: React.ChangeEvent<HTMLInputElement>) => void;
  placeholder?: string;
  readOnly?: boolean;
  required?: boolean;
  step?: string;
  type?: string;
  value?: string | number;
}) {
  return (
    <label className="grid gap-2 text-sm font-semibold text-foreground">
      {label}
      <input
        className={cn(
          "h-11 rounded-md border border-border bg-background px-3 text-sm font-normal outline-none focus:border-role-admin",
          readOnly && "cursor-not-allowed bg-muted/50 text-muted-foreground",
        )}
        defaultValue={defaultValue}
        max={max}
        min={min}
        name={name}
        onChange={onChange}
        placeholder={placeholder}
        readOnly={readOnly}
        required={required}
        step={step}
        type={type}
        value={value}
      />
      {hint ? (
        <span className="text-[11px] font-normal text-muted-foreground">{hint}</span>
      ) : null}
    </label>
  );
}

export function Select({
  children,
  defaultValue,
  label,
  name,
  onChange,
  required,
  value,
}: {
  children: ReactNode;
  defaultValue?: string;
  label: string;
  name: string;
  onChange?: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  required?: boolean;
  value?: string;
}) {
  return (
    <label className="grid gap-2 text-sm font-semibold text-foreground">
      {label}
      <select
        className="h-11 rounded-md border border-border bg-background px-3 text-sm font-normal outline-none focus:border-role-admin"
        defaultValue={defaultValue}
        name={name}
        onChange={onChange}
        required={required}
        value={value}
      >
        {children}
      </select>
    </label>
  );
}

export function TextArea({
  defaultValue,
  label,
  name,
  onChange,
  placeholder,
  value,
}: {
  defaultValue?: string;
  label: ReactNode;
  name: string;
  /** Pass with `value` to drive the field from state — a live preview needs both. */
  onChange?: (event: React.ChangeEvent<HTMLTextAreaElement>) => void;
  placeholder?: string;
  value?: string;
}) {
  return (
    <label className="grid gap-2 text-sm font-semibold text-foreground">
      {label}
      <textarea
        className="min-h-24 rounded-md border border-border bg-background px-3 py-2 text-sm font-normal outline-none focus:border-role-admin"
        defaultValue={defaultValue}
        name={name}
        onChange={onChange}
        placeholder={placeholder}
        value={value}
      />
    </label>
  );
}

export function LoadingRows() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 4 }).map((_, index) => (
        <div className="h-12 animate-pulse rounded-md bg-muted" key={index} />
      ))}
    </div>
  );
}

/** Nothing here yet: one mark and one line, no box. */
/**
 * The picture every empty page and card wears: soft rings, a slowly turning
 * dashed orbit, a floating tile carrying the page's glyph and a few twinkling
 * sparks. A blank with two lines of text reads as broken; this reads as "nothing
 * here yet", the way the app's empty screens do.
 */
export function EmptyArt({ glyph = "inbox", size = 120 }: { glyph?: GlyphName; size?: number }) {
  return (
    <div aria-hidden className="relative text-role-team" style={{ height: size, width: size }}>
      <svg className="absolute inset-0 size-full" viewBox="0 0 120 120">
        <circle cx="60" cy="60" fill="currentColor" fillOpacity="0.06" r="56" />
        <circle cx="60" cy="60" fill="currentColor" fillOpacity="0.1" r="41" />
        <circle
          className="empty-ring"
          cx="60"
          cy="60"
          fill="none"
          r="49"
          stroke="currentColor"
          strokeDasharray="2 6"
          strokeLinecap="round"
          strokeOpacity="0.35"
          strokeWidth="1.4"
        />
        <circle className="empty-twinkle" cx="101" cy="30" fill="currentColor" r="3.5" />
        <circle className="empty-twinkle" cx="14" cy="78" fill="currentColor" r="2.5" style={{ "--twinkle-delay": "0.8s" } as CSSProperties} />
        <circle className="empty-twinkle" cx="30" cy="104" fill="currentColor" r="2" style={{ "--twinkle-delay": "1.5s" } as CSSProperties} />
      </svg>
      <span
        className="empty-float absolute left-1/2 top-1/2 flex items-center justify-center rounded-2xl bg-card shadow-md ring-1 ring-border"
        style={{ height: size * 0.45, marginLeft: -size * 0.225, marginTop: -size * 0.225, width: size * 0.45 }}
      >
        <Glyph className="size-1/2" name={glyph} />
      </span>
    </div>
  );
}

export function EmptyState({ action, glyph, label }: { action?: ReactNode; glyph?: GlyphName; label: string }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
      <EmptyArt glyph={glyph} />
      <p className="max-w-xs text-sm font-medium text-muted-foreground">{label}</p>
      {action}
    </div>
  );
}

export function RefreshButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm font-semibold text-foreground"
      onClick={onClick}
      type="button"
    >
      <RefreshCw className="size-4" />
      Refresh
    </button>
  );
}
