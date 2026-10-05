"use client";

import type { KeyboardEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { ChevronDown, Star, TrendingDown, TrendingUp, X } from "lucide-react";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";

/*
 * Kept in step with the union in `portal-shell.tsx`, which is what decides
 * which portal wears which tone.
 *
 * `team` is the one tone whose solid fill is not `bg-role-team`: that token
 * goes bright (#34d399) in dark mode so it can carry text on a dark card, and
 * white on it measures 1.8:1. The solids below paint `--brand-teal` instead,
 * which is #0a8a4b in both themes and clears AA under white.
 */
export type PortalTone = "platform" | "admin" | "resident" | "guardian" | "team";
export type SoftTone =
  | "green"
  | "amber"
  | "rose"
  | "blue"
  | "slate"
  | "cyan"
  | "purple"
  | "teal";

const softToneClasses: Record<SoftTone, string> = {
  amber:
    "border-amber-200/80 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  blue: "border-blue-200/80 bg-blue-50 text-blue-700 dark:border-blue-900 dark:bg-blue-950/40 dark:text-blue-300",
  cyan: "border-cyan-200/80 bg-cyan-50 text-cyan-700 dark:border-cyan-900 dark:bg-cyan-950/40 dark:text-cyan-300",
  green:
    "border-emerald-200/80 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  purple:
    "border-violet-200/80 bg-violet-50 text-violet-700 dark:border-violet-900 dark:bg-violet-950/40 dark:text-violet-300",
  rose: "border-rose-200/80 bg-rose-50 text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300",
  slate: "border-border bg-muted text-muted-foreground",
  teal: "border-role-platform/25 bg-role-platform-soft text-role-platform",
};

const roleLinkClasses: Record<PortalTone, string> = {
  admin: "text-role-admin hover:text-role-admin/80",
  guardian: "text-role-guardian hover:text-role-guardian/80",
  platform: "text-role-platform hover:text-role-platform/80",
  resident: "text-role-resident hover:text-role-resident/80",
  team: "text-role-team hover:text-role-team/80",
};

const roleSolidClasses: Record<PortalTone, string> = {
  admin: "bg-role-admin text-white hover:bg-role-admin/90",
  guardian: "bg-role-guardian text-white hover:bg-role-guardian/90",
  platform: "bg-role-platform text-white hover:bg-role-platform/90",
  resident: "bg-role-resident text-white hover:bg-role-resident/90",
  team: "bg-brand-teal text-white hover:bg-brand-teal/90",
};

const avatarToneClasses: Record<PortalTone, string> = {
  admin: "bg-role-admin-soft text-role-admin",
  guardian: "bg-role-guardian-soft text-role-guardian",
  platform: "bg-role-platform-soft text-role-platform",
  resident: "bg-role-resident-soft text-role-resident",
  team: "bg-role-team-soft text-role-team",
};

const roleTextClasses: Record<PortalTone, string> = {
  admin: "text-role-admin",
  guardian: "text-role-guardian",
  platform: "text-role-platform",
  resident: "text-role-resident",
  team: "text-role-team",
};

const roleBorderClasses: Record<PortalTone, string> = {
  admin: "border-role-admin",
  guardian: "border-role-guardian",
  platform: "border-role-platform",
  resident: "border-role-resident",
  team: "border-role-team",
};

export type BreadcrumbItem = string | { href: string; label: string };

function breadcrumbLabel(item: BreadcrumbItem) {
  return typeof item === "string" ? item : item.label;
}

function breadcrumbHref(item: BreadcrumbItem) {
  return typeof item === "string" ? undefined : item.href;
}

export function PortalPageHeader({
  actions,
  breadcrumb,
  description,
  title,
}: {
  actions?: ReactNode;
  breadcrumb?: BreadcrumbItem[];
  description?: string;
  title: string;
}) {
  return (
    <div className="flex flex-col gap-2.5 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 space-y-0.5">
        {breadcrumb && breadcrumb.length > 0 ? (
          <p className="text-[11px] font-medium text-muted-foreground">
            {breadcrumb.map((item, index) => {
              const href = breadcrumbHref(item);
              const isLast = index === breadcrumb.length - 1;

              return (
                <span key={`${breadcrumbLabel(item)}-${index}`}>
                  {index > 0 ? (
                    <span className="mx-1 text-muted-foreground/50">›</span>
                  ) : null}
                  {href && !isLast ? (
                    <Link className="hover:text-foreground hover:underline" href={href}>
                      {breadcrumbLabel(item)}
                    </Link>
                  ) : (
                    <span className={isLast ? "text-foreground" : ""}>
                      {breadcrumbLabel(item)}
                    </span>
                  )}
                </span>
              );
            })}
          </p>
        ) : null}
        <h1 className="font-heading text-lg font-bold tracking-tight text-foreground md:text-xl">
          {title}
        </h1>
        {description ? (
          <p className="max-w-2xl text-[12.5px] text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </div>
  );
}

const noteToneClasses: Record<SoftTone, string> = {
  amber: "text-amber-600",
  blue: "text-blue-600",
  cyan: "text-cyan-600",
  green: "text-emerald-600",
  purple: "text-violet-600",
  rose: "text-rose-600",
  slate: "text-muted-foreground",
  teal: "text-role-platform",
};

const iconToneClasses: Record<SoftTone, string> = {
  amber: "bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400",
  blue: "bg-blue-50 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400",
  cyan: "bg-cyan-50 text-cyan-600 dark:bg-cyan-950/40 dark:text-cyan-400",
  green: "bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400",
  purple: "bg-violet-50 text-violet-600 dark:bg-violet-950/40 dark:text-violet-400",
  rose: "bg-rose-50 text-rose-600 dark:bg-rose-950/40 dark:text-rose-400",
  slate: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
  teal: "bg-role-platform-soft text-role-platform",
};

/**
 * `onClick` turns the card into a filter for whatever it counts.
 *
 * Optional, because most metric cards are readouts and nothing more — a card
 * that looks pressable but is not is worse than a plain one. When it is given,
 * the card becomes a real button: focusable, keyboard-operable, and visibly
 * interactive on hover.
 */
export function MetricCard({
  active = false,
  icon: Icon,
  label,
  note,
  noteTone = "slate",
  onClick,
  tone = "teal",
  trend,
  trendDown = false,
  value,
}: {
  active?: boolean;
  icon: LucideIcon;
  label: string;
  note?: string;
  noteTone?: SoftTone;
  onClick?: () => void;
  tone?: SoftTone;
  trend?: string;
  trendDown?: boolean;
  value: ReactNode;
}) {
  return (
    <Card
      className={cn(
        "shadow-sm ring-border/60",
        onClick && "cursor-pointer transition hover:ring-2 hover:ring-role-admin/40",
        active && "ring-2 ring-role-admin",
      )}
      {...(onClick
        ? {
            "aria-pressed": active,
            onClick,
            onKeyDown: (event: KeyboardEvent) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onClick();
              }
            },
            role: "button",
            tabIndex: 0,
          }
        : {})}
      size="sm"
    >
      <CardContent>
        <div className="flex items-start gap-2.5">
          <span
            className={cn(
              "flex size-9 shrink-0 items-center justify-center rounded-lg",
              iconToneClasses[tone],
            )}
          >
            <Icon className="size-[17px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
            <p className="mt-0.5 truncate text-[19px] font-bold leading-tight tracking-tight text-foreground">
              {value}
            </p>
            {trend ? (
              <p
                className={cn(
                  "mt-1 inline-flex items-center gap-1 text-[10.5px] font-semibold",
                  trendDown ? "text-rose-600" : "text-emerald-600",
                )}
              >
                {trendDown ? (
                  <TrendingDown className="size-3" />
                ) : (
                  <TrendingUp className="size-3" />
                )}
                {trend}
              </p>
            ) : note ? (
              <p
                className={cn(
                  "mt-1 text-[10.5px] font-semibold",
                  noteToneClasses[noteTone],
                )}
              >
                {note}
              </p>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export function SectionCard({
  actions,
  icon: Icon,
  children,
  className,
  description,
  title,
}: {
  actions?: ReactNode;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
  description?: string;
  title?: string;
}) {
  return (
    <Card className={cn("shadow-sm ring-border/60", className)} size="sm">
      {title || actions || description ? (
        <CardHeader className="border-b border-border/60 pb-3">
          {title ? (
            <CardTitle className="flex items-center gap-2 font-heading text-[13.5px] font-bold text-foreground">
              {Icon ? <Icon className="size-4 text-muted-foreground" strokeWidth={1.7} /> : null}
              {title}
            </CardTitle>
          ) : null}
          {description ? (
            <CardDescription className="text-[12px]">{description}</CardDescription>
          ) : null}
          {actions ? <CardAction>{actions}</CardAction> : null}
        </CardHeader>
      ) : null}
      <CardContent className={title || actions || description ? "pt-3" : undefined}>
        {children}
      </CardContent>
    </Card>
  );
}

export function SoftBadge({
  children,
  className,
  tone = "slate",
}: {
  children: ReactNode;
  className?: string;
  tone?: SoftTone;
}) {
  return (
    <Badge
      className={cn(
        "h-auto rounded-full border px-2 py-0.5 text-[10.5px] font-semibold shadow-none",
        softToneClasses[tone],
        className,
      )}
      variant="outline"
    >
      {children}
    </Badge>
  );
}

/**
 * A person's avatar: their photograph, with their initials behind it.
 *
 * `image` is a `User.image` — `/api/v1/users/<id>/avatar` for the photo they
 * put on their ID card, or a sign-in provider's URL. It is served from our own
 * origin behind the session cookie, so a plain `<img>` inside Radix's `Avatar`
 * loads it; Radix swaps to the fallback on its own when the URL 404s, which is
 * the same "photo that exists and cannot be drawn" case the app handles.
 *
 * The initials stay the default because most accounts still have no picture —
 * this is not a component that shows a grey silhouette.
 */
export function InitialsAvatar({
  className,
  image,
  name,
  size = "md",
  tone = "platform",
}: {
  className?: string;
  image?: string | null;
  name: string;
  size?: "sm" | "md" | "lg";
  tone?: PortalTone;
}) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

  const sizeClass =
    size === "sm"
      ? "size-7 text-[10px]"
      : size === "lg"
        ? "size-12 text-base data-[size=lg]:size-12"
        : "size-9 text-[12px] data-[size=default]:size-9";

  return (
    <Avatar className={cn(sizeClass, className)} size={size === "sm" ? "sm" : "lg"}>
      {/* Google-hosted photos refuse requests that carry a referrer. */}
      {image ? <AvatarImage alt="" referrerPolicy="no-referrer" src={image} /> : null}
      <AvatarFallback
        className={cn(
          "font-bold",
          avatarToneClasses[tone],
          size === "sm" && "text-[10px]",
        )}
      >
        {initials || "?"}
      </AvatarFallback>
    </Avatar>
  );
}

export function ViewAllLink({
  href,
  label = "View all",
  tone = "platform",
}: {
  href: string;
  label?: string;
  tone?: PortalTone;
}) {
  return (
    <Link
      className={cn(
        "text-[11.5px] font-semibold transition hover:underline",
        roleLinkClasses[tone],
      )}
      href={href}
    >
      {label}
    </Link>
  );
}

export function RoleButton({
  children,
  className,
  tone = "platform",
  variant = "solid",
  ...props
}: Omit<ComponentProps<typeof Button>, "variant"> & {
  tone?: PortalTone;
  variant?: "solid" | "outline" | "soft";
}) {
  return (
    <Button
      className={cn(
        "h-8 gap-1.5 rounded-lg px-3 text-[12.5px] font-semibold shadow-sm",
        variant === "solid" && roleSolidClasses[tone],
        variant === "outline" &&
          cn(
            "border bg-card",
            tone === "platform" &&
              "border-role-platform/30 text-role-platform hover:bg-role-platform-soft",
            tone === "admin" &&
              "border-role-admin/30 text-role-admin hover:bg-role-admin-soft",
            tone === "resident" &&
              "border-role-resident/30 text-role-resident hover:bg-role-resident-soft",
            tone === "guardian" &&
              "border-role-guardian/30 text-role-guardian hover:bg-role-guardian-soft",
          ),
        variant === "soft" &&
          cn(
            "border",
            tone === "platform" &&
              "border-role-platform/20 bg-role-platform-soft text-role-platform",
            tone === "admin" && "border-role-admin/20 bg-role-admin-soft text-role-admin",
            tone === "resident" &&
              "border-role-resident/20 bg-role-resident-soft text-role-resident",
            tone === "guardian" &&
              "border-role-guardian/20 bg-role-guardian-soft text-role-guardian",
          ),
        className,
      )}
      variant={variant === "solid" ? "default" : "outline"}
      {...props}
    >
      {children}
    </Button>
  );
}

export function DataTable({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <Table className={cn("min-w-full text-[12.5px]", className)}>{children}</Table>;
}

/** Uppercase micro-label used for every table column header in the portals. */
export function Th({
  align = "left",
  children,
  className,
}: {
  align?: "left" | "right" | "center";
  /** Omitted for spacer columns (checkbox / row-action gutters). */
  children?: ReactNode;
  className?: string;
}) {
  return (
    <TableHead
      className={cn(
        "h-9 text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground",
        align === "right" && "text-right",
        align === "center" && "text-center",
        className,
      )}
    >
      {children}
    </TableHead>
  );
}

export { TableBody, TableCell, TableHead, TableHeader, TableRow };

export function SimpleSparkline({
  color = "bg-role-platform",
  values,
}: {
  color?: string;
  values: number[];
}) {
  const max = Math.max(...values, 1);

  return (
    <div className="flex h-16 items-end gap-1">
      {values.map((value, index) => (
        <div
          className={cn("flex-1 rounded-t-sm opacity-80", color)}
          key={index}
          style={{ height: `${Math.max(12, (value / max) * 100)}%` }}
        />
      ))}
    </div>
  );
}

export function AreaSparkline({
  labels,
  stroke = "#0d9488",
  values,
}: {
  labels?: string[];
  stroke?: string;
  values: number[];
}) {
  const width = 320;
  const height = 96;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const range = max - min || 1;
  const stepX = width / (values.length - 1 || 1);
  const points = values.map((value, index) => {
    const x = index * stepX;
    const y = height - ((value - min) / range) * (height - 8) - 4;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point}`)
    .join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const gradientId = `area-${stroke.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <div>
      <svg
        className="h-20 w-full"
        preserveAspectRatio="none"
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity="0.22" />
            <stop offset="100%" stopColor={stroke} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#${gradientId})`} />
        <path
          d={line}
          fill="none"
          stroke={stroke}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
        />
      </svg>
      {labels && labels.length > 0 ? (
        <div className="mt-1 flex justify-between text-[9.5px] text-muted-foreground">
          {labels.map((label, index) => (
            <span key={`${label}-${index}`}>{label}</span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function EmptyInline({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-muted/20 px-3 py-8 text-center text-[12.5px] text-muted-foreground">
      {label}
    </div>
  );
}

export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border/70 bg-muted/20 p-2.5 lg:flex-row lg:items-center lg:justify-between">
      {children}
    </div>
  );
}

/**
 * `size="lg"` is for a search that is the primary control on its section rather
 * than one filter among several in a `FilterBar`. The default 36px row reads as
 * a chip next to a full-width table and was hard to hit on touch; `lg` matches
 * the 44px of the buttons beside it.
 */
export function SearchField({
  className,
  onChange,
  placeholder,
  size = "sm",
  value,
}: {
  className?: string;
  onChange: (value: string) => void;
  placeholder?: string;
  size?: "lg" | "sm";
  value: string;
}) {
  const large = size === "lg";

  return (
    <div
      className={cn(
        "flex max-w-md flex-1 items-center gap-2 rounded-lg border border-border bg-card shadow-sm",
        large ? "h-12 gap-3 rounded-xl px-4" : "h-9 px-2.5",
        className,
      )}
    >
      <svg
        aria-hidden
        className={cn("shrink-0 text-muted-foreground", large ? "size-4" : "size-3.5")}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        viewBox="0 0 24 24"
      >
        <circle cx="11" cy="11" r="8" />
        <path d="m21 21-4.3-4.3" />
      </svg>
      <input
        aria-label={placeholder ?? "Search"}
        className={cn(
          "w-full bg-transparent outline-none placeholder:text-muted-foreground",
          large ? "text-sm" : "text-[12.5px]",
        )}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder ?? "Search..."}
        value={value}
      />
    </div>
  );
}

const pagerActiveTone: Record<PortalTone, string> = {
  admin: "bg-role-admin text-white",
  guardian: "bg-role-guardian text-white",
  platform: "bg-role-platform text-white",
  resident: "bg-role-resident text-white",
  team: "bg-brand-teal text-white",
};

function PagerButton({
  active,
  disabled,
  label,
  onClick,
  tone = "platform",
}: {
  active?: boolean;
  disabled?: boolean;
  label: string;
  onClick?: () => void;
  tone?: PortalTone;
}) {
  return (
    <button
      className={cn(
        "flex size-6 items-center justify-center rounded text-[11px] transition",
        active
          ? cn("font-semibold", pagerActiveTone[tone])
          : "border border-border font-medium text-muted-foreground hover:bg-muted disabled:opacity-40 disabled:hover:bg-transparent",
      )}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {label}
    </button>
  );
}

/**
 * Pager for client-side sliced lists. `page`/`onPageChange` make it live;
 * omitting them renders a static "showing 1 to N" summary.
 */
export function ListPager({
  onPageChange,
  page = 1,
  pageSize = 10,
  showPageSize = false,
  tone = "platform",
  total,
  unit,
}: {
  onPageChange?: (page: number) => void;
  page?: number;
  pageSize?: number;
  showPageSize?: boolean;
  tone?: PortalTone;
  total: number;
  unit?: string;
}) {
  const lastPage = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), lastPage);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(current * pageSize, total);

  const pages: number[] = [];
  for (let index = 1; index <= lastPage; index += 1) {
    if (index === 1 || index === lastPage || Math.abs(index - current) <= 1) {
      pages.push(index);
    }
  }

  return (
    <div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-2.5 text-[11px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
      <span>
        Showing {from} to {to} of {total.toLocaleString()}
        {unit ? ` ${unit}` : ""}
      </span>
      <div className="flex items-center gap-1">
        <PagerButton
          disabled={current <= 1}
          label="‹"
          onClick={() => onPageChange?.(current - 1)}
          tone={tone}
        />
        {pages.map((value, index) => (
          <span className="flex items-center gap-1" key={value}>
            {index > 0 && value - pages[index - 1] > 1 ? (
              <span className="px-0.5">…</span>
            ) : null}
            <PagerButton
              active={value === current}
              label={String(value)}
              onClick={() => onPageChange?.(value)}
              tone={tone}
            />
          </span>
        ))}
        <PagerButton
          disabled={current >= lastPage}
          label="›"
          onClick={() => onPageChange?.(current + 1)}
          tone={tone}
        />
        {showPageSize ? (
          <span className="ml-1.5 inline-flex h-6 items-center gap-1 rounded border border-border px-1.5 text-[10.5px] font-medium text-muted-foreground">
            {pageSize} / page
            <ChevronDown className="size-3" />
          </span>
        ) : null}
      </div>
    </div>
  );
}

export function RatingStars({ count, rating }: { count?: number; rating: number }) {
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-foreground">
      <Star className="size-3 fill-amber-400 text-amber-400" />
      {rating.toFixed(1)}
      {count != null ? (
        <span className="font-normal text-muted-foreground">({count})</span>
      ) : null}
    </span>
  );
}

export function FilterSelect({
  className,
  defaultLabel,
  label,
  onChange,
  options = [],
  value,
}: {
  className?: string;
  defaultLabel: string;
  label?: string;
  onChange?: (value: string) => void;
  /** Derived lists arrive with holes in them; see `normalized` below. */
  options?: Array<string | { label: string; value: string } | null | undefined>;
  value?: string;
}) {
  /*
   * Options are almost always derived — `Array.from(new Set(rows.map((row) =>
   * row.hostelName)))` and its thirty siblings — and a row whose field is null
   * puts a null in that list however the type reads. Rendering it threw, which
   * took the whole page down: `/platform/transactions` and `/platform/payments`
   * both crashed on open for exactly one unnamed hostel in the ledger.
   *
   * A filter option with no value cannot filter anything, so it is dropped
   * rather than defended against further down. Values are stringified for the
   * same reason: a numeric id is a perfectly reasonable thing for a caller to
   * pass, and `<option value={7}>` compares unequal to the string the change
   * event hands back.
   */
  const normalized = options.flatMap((option) => {
    if (option == null) {
      return [];
    }

    if (typeof option === "object") {
      return option.value == null || option.value === ""
        ? []
        : [{ label: option.label ?? String(option.value), value: String(option.value) }];
    }

    const value = String(option);

    return value ? [{ label: value, value }] : [];
  });

  return (
    <div className={cn("min-w-0", className)}>
      {label ? (
        <p className="mb-1 text-[10.5px] font-semibold text-muted-foreground">{label}</p>
      ) : null}
      <div className="relative">
        <select
          className="h-9 w-full appearance-none rounded-lg border border-border bg-card px-2.5 pr-7 text-[12.5px] text-foreground shadow-sm outline-none"
          onChange={(event) => onChange?.(event.target.value)}
          {...(onChange ? { value: value ?? "" } : { defaultValue: "" })}
        >
          <option value="">{defaultLabel}</option>
          {normalized.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Tabs, rails, and detail panels                                             */
/* -------------------------------------------------------------------------- */

export type TabDefinition = { count?: number; key: string; label: string };

/** Underline tab strip with optional counts (Paid (78) / Unpaid (12) / …). */
export function TabBar({
  className,
  onChange,
  tabs,
  tone = "platform",
  value,
}: {
  className?: string;
  onChange: (key: string) => void;
  tabs: TabDefinition[];
  tone?: PortalTone;
  value: string;
}) {
  return (
    <div
      className={cn(
        "no-scrollbar flex gap-4 overflow-x-auto border-b border-border/60",
        className,
      )}
    >
      {tabs.map((tab) => {
        const active = tab.key === value;

        return (
          <button
            className={cn(
              "-mb-px shrink-0 border-b-2 pb-2 text-[12.5px] transition-colors",
              active
                ? cn("font-semibold", roleBorderClasses[tone], roleTextClasses[tone])
                : "border-transparent font-medium text-muted-foreground hover:text-foreground",
            )}
            key={tab.key}
            onClick={() => onChange(tab.key)}
            type="button"
          >
            {tab.label}
            {tab.count != null ? ` (${tab.count})` : ""}
          </button>
        );
      })}
    </div>
  );
}

/** Right-hand inspector column used by the master–detail screens. */
export function DetailPanel({
  children,
  className,
  footer,
  onClose,
  subtitle,
  title,
}: {
  children: ReactNode;
  className?: string;
  footer?: ReactNode;
  onClose?: () => void;
  subtitle?: ReactNode;
  title: ReactNode;
}) {
  return (
    <aside
      className={cn(
        "flex max-h-[calc(100vh-9rem)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-sm",
        className,
      )}
    >
      <div className="flex shrink-0 items-start gap-2 border-b border-border/60 p-3">
        <div className="min-w-0 flex-1">
          <div className="font-heading text-[14px] font-bold text-foreground">
            {title}
          </div>
          {subtitle ? (
            <div className="mt-0.5 text-[11.5px] text-muted-foreground">{subtitle}</div>
          ) : null}
        </div>
        {onClose ? (
          <button
            aria-label="Close details"
            className="rounded-md p-1 text-muted-foreground transition hover:bg-muted hover:text-foreground"
            onClick={onClose}
            type="button"
          >
            <X className="size-3.5" />
          </button>
        ) : null}
      </div>

      <div className="no-scrollbar min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3">
        {children}
      </div>

      {footer ? (
        <div className="shrink-0 border-t border-border/60 p-3">{footer}</div>
      ) : null}
    </aside>
  );
}

/** Bordered sub-card inside a DetailPanel (Personal Information, Guardian, …). */
export function DetailSection({
  action,
  children,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="rounded-lg border border-border/70 bg-muted/15 p-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <h3 className="text-[12px] font-bold text-foreground">{title}</h3>
        {action}
      </div>
      <div className="space-y-1">{children}</div>
    </section>
  );
}

export function DetailField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-[11.5px]">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-right font-medium text-foreground">
        {value ?? "—"}
      </span>
    </div>
  );
}

/** Compact segmented tabs used inside a DetailPanel header. */
export function PanelTabs({
  onChange,
  tabs,
  tone = "platform",
  value,
}: {
  onChange: (key: string) => void;
  tabs: TabDefinition[];
  tone?: PortalTone;
  value: string;
}) {
  return (
    <div className="no-scrollbar flex gap-3 overflow-x-auto border-b border-border/60">
      {tabs.map((tab) => {
        const active = tab.key === value;

        return (
          <button
            className={cn(
              "-mb-px shrink-0 border-b-2 pb-1.5 text-[11.5px] transition-colors",
              active
                ? cn("font-semibold", roleBorderClasses[tone], roleTextClasses[tone])
                : "border-transparent font-medium text-muted-foreground hover:text-foreground",
            )}
            key={tab.key}
            onClick={() => onChange(tab.key)}
            type="button"
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

/** Small labelled card for the right rail (Payment Proofs, Active Tickets, …). */
export function RailCard({
  action,
  children,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  title: string;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
        <h3 className="font-heading text-[13px] font-bold text-foreground">{title}</h3>
        {action}
      </div>
      <div className="space-y-2 p-2.5">{children}</div>
    </section>
  );
}

export function ToggleSwitch({
  checked,
  description,
  label,
  onChange,
  tone = "platform",
}: {
  checked: boolean;
  description?: string;
  label: string;
  onChange: (next: boolean) => void;
  tone?: PortalTone;
}) {
  const onClasses: Record<PortalTone, string> = {
    admin: "bg-role-admin",
    guardian: "bg-role-guardian",
    platform: "bg-role-platform",
    resident: "bg-role-resident",
    team: "bg-brand-teal",
  };

  return (
    <label className="flex cursor-pointer items-start justify-between gap-3 py-1.5">
      <span className="min-w-0">
        <span className="block text-[12.5px] font-semibold text-foreground">{label}</span>
        {description ? (
          <span className="mt-0.5 block text-[11px] leading-4 text-muted-foreground">
            {description}
          </span>
        ) : null}
      </span>
      <button
        aria-checked={checked}
        aria-label={label}
        className={cn(
          "relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors",
          checked ? onClasses[tone] : "bg-muted-foreground/30",
        )}
        onClick={() => onChange(!checked)}
        role="switch"
        type="button"
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full bg-white shadow transition-all",
            checked ? "left-[18px]" : "left-0.5",
          )}
        />
      </button>
    </label>
  );
}

export function statusToneFromLabel(status: string): SoftTone {
  const value = status.toLowerCase();
  if (["unpaid", "overdue", "inactive", "unverified", "unavailable"].includes(value)) return "rose";
  if (value === "partial" || value === "partially_paid") return "amber";
  if (value === "settled") return "green";
  if (
    value.includes("paid") ||
    value.includes("active") ||
    value.includes("approved") ||
    value.includes("verified") ||
    value.includes("inside") ||
    value.includes("resolved") ||
    value.includes("activated") ||
    value.includes("completed") ||
    value.includes("published") ||
    value.includes("available") ||
    value.includes("normal")
  ) {
    return "green";
  }
  if (
    value.includes("pending") ||
    value.includes("review") ||
    value.includes("due") ||
    value.includes("partial") ||
    value.includes("busy") ||
    value.includes("scheduled") ||
    value.includes("draft") ||
    value.includes("not generated")
  ) {
    return "amber";
  }
  if (
    value.includes("overdue") ||
    value.includes("rejected") ||
    value.includes("unpaid") ||
    value.includes("outside") ||
    value.includes("suspended") ||
    value.includes("urgent") ||
    value.includes("failed") ||
    value.includes("open")
  ) {
    return "rose";
  }
  if (value.includes("progress") || value.includes("submitted")) {
    return "cyan";
  }
  return "slate";
}
