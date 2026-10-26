"use client";
/* eslint-disable @typescript-eslint/no-unused-vars */

import {
  AlertCircle,
  ArrowRight,
  BadgeCheck,
  BedDouble,
  Bell,
  Building2,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  Download,
  FileCheck2,
  Filter,
  Grid2X2,
  Heart,
  Home,
  KeyRound,
  LockKeyhole,
  Mail,
  MapPin,
  MessageSquare,
  Moon,
  MoreVertical,
  Phone,
  Plus,
  QrCode,
  Search,
  Send,
  ShieldCheck,
  SlidersHorizontal,
  Star,
  Upload,
  User,
  UserRound,
  Users,
  Utensils,
  Wifi,
  WalletCards,
  Wrench,
  X,
  type IconComponent,
} from "@/components/icons";
import { motion } from "framer-motion";
import Link from "next/link";
import { optimizedImage } from "@/lib/image-url";
import { useParams } from "next/navigation";
import { useMemo, useState, type ReactNode } from "react";

import { PublicHeader } from "@/components/public-header";
import { ListingTierBadge } from "@/app/_components/listing-tier-badge";
import type { HostelSummary, Tone } from "@/app/_components/public-hostel-types";
import { cn } from "@/lib/utils";

export type PortalKind = "admin" | "guardian" | "platform" | "resident";
export type AuthMode = "activation" | "login" | "otp" | "reset" | "signup";

export const toneStyles: Record<
  Tone,
  {
    bg: string;
    border: string;
    button: string;
    icon: string;
    pill: string;
    soft: string;
    text: string;
  }
> = {
  admin: {
    bg: "bg-role-admin",
    border: "border-role-admin/25",
    button: "bg-role-admin text-white hover:brightness-105",
    icon: "bg-role-admin-soft text-role-admin",
    pill: "bg-role-admin-soft text-role-admin",
    soft: "bg-role-admin-soft/70",
    text: "text-role-admin",
  },
  danger: {
    bg: "bg-danger",
    border: "border-danger/25",
    button: "bg-danger text-white hover:brightness-105",
    icon: "bg-red-50 text-danger",
    pill: "bg-red-50 text-danger",
    soft: "bg-red-50",
    text: "text-danger",
  },
  guardian: {
    bg: "bg-role-guardian",
    border: "border-role-guardian/25",
    button: "bg-role-guardian text-white hover:brightness-105",
    icon: "bg-role-guardian-soft text-role-guardian",
    pill: "bg-role-guardian-soft text-role-guardian",
    soft: "bg-role-guardian-soft/80",
    text: "text-role-guardian",
  },
  platform: {
    bg: "bg-role-platform",
    border: "border-role-platform/25",
    button: "bg-role-platform text-white hover:brightness-105",
    icon: "bg-role-platform-soft text-role-platform",
    pill: "bg-role-platform-soft text-role-platform",
    soft: "bg-role-platform-soft/70",
    text: "text-role-platform",
  },
  resident: {
    bg: "bg-role-resident",
    border: "border-role-resident/25",
    button: "bg-role-resident text-white hover:brightness-105",
    icon: "bg-role-resident-soft text-role-resident",
    pill: "bg-role-resident-soft text-role-resident",
    soft: "bg-role-resident-soft/75",
    text: "text-role-resident",
  },
  slate: {
    bg: "bg-slate-700",
    border: "border-border",
    button: "bg-slate-800 text-white hover:bg-slate-700",
    icon: "bg-muted text-muted-foreground",
    pill: "bg-muted text-muted-foreground",
    soft: "bg-muted/50",
    text: "text-muted-foreground",
  },
  success: {
    bg: "bg-success",
    border: "border-success/25",
    button: "bg-success text-white hover:brightness-105",
    icon: "bg-emerald-50 text-success",
    pill: "bg-emerald-50 text-success",
    soft: "bg-emerald-50",
    text: "text-success",
  },
  teal: {
    bg: "bg-brand-teal",
    border: "border-brand-teal/25",
    button: "bg-brand-teal text-white hover:brightness-105",
    icon: "bg-brand-teal-soft text-brand-teal",
    pill: "bg-brand-teal-soft text-brand-teal",
    soft: "bg-brand-teal-soft/70",
    text: "text-brand-teal",
  },
  warning: {
    bg: "bg-warning",
    border: "border-warning/25",
    button: "bg-warning text-white hover:brightness-105",
    icon: "bg-amber-50 text-warning",
    pill: "bg-amber-50 text-warning",
    soft: "bg-amber-50",
    text: "text-warning",
  },
};

export const metricIcons: IconComponent[] = [
  Building2,
  CalendarDays,
  Users,
  MessageSquare,
  Wrench,
  AlertCircle,
  WalletCards,
  BedDouble,
];

export function formatMoney(value: number) {
  return `NPR ${value.toLocaleString()}`;
}

export function statusTone(status: string): Tone {
  const value = status.toLowerCase();

  if (
    value.includes("paid") ||
    value.includes("approved") ||
    value.includes("inside") ||
    value.includes("activated") ||
    value.includes("published") ||
    value.includes("verified") ||
    value.includes("resolved")
  ) {
    return "success";
  }

  if (
    value.includes("pending") ||
    value.includes("review") ||
    value.includes("partial") ||
    value.includes("draft") ||
    value.includes("due")
  ) {
    return "warning";
  }

  if (
    value.includes("overdue") ||
    value.includes("outside") ||
    value.includes("rejected") ||
    value.includes("abuse") ||
    value.includes("open")
  ) {
    return "danger";
  }

  return "slate";
}

export function humanize(value: string) {
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function StatusPill({
  children,
  tone,
  className,
}: {
  children: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  const resolvedTone =
    tone ?? (typeof children === "string" ? statusTone(children) : "slate");

  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-semibold capitalize",
        toneStyles[resolvedTone].pill,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function AnimatedPage({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <main className={className}>{children}</main>;
}

export function SectionCard({
  action,
  children,
  className,
  description,
  title,
}: {
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  description?: string;
  title?: string;
}) {
  return (
    <section className={cn("app-card overflow-hidden", className)}>
      {title ? (
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">{title}</h2>
            {description ? (
              <p className="mt-1 text-sm text-muted-foreground">{description}</p>
            ) : null}
          </div>
          {action ? <div className="shrink-0">{action}</div> : null}
        </div>
      ) : null}
      <div className={cn(title && "p-5")}>{children}</div>
    </section>
  );
}

export function MetricCard({
  detail,
  icon: Icon,
  label,
  tone,
  value,
}: {
  detail: string;
  icon: IconComponent;
  label: string;
  tone: Tone;
  value: string;
}) {
  return (
    <motion.article
      className="app-card p-5"
      transition={{ duration: 0.2 }}
      whileHover={{ y: -3 }}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className="mt-3 text-2xl font-bold text-foreground">{value}</p>
        </div>
        <span className={cn("rounded-lg p-3", toneStyles[tone].icon)}>
          <Icon className="size-5" />
        </span>
      </div>
      <p className={cn("mt-4 text-xs font-semibold", toneStyles[tone].text)}>{detail}</p>
    </motion.article>
  );
}

export function TableView({
  headers,
  rows,
}: {
  headers: string[];
  rows: Array<Array<ReactNode>>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-sm">
        <thead className="bg-muted/40 text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            {headers.map((header) => (
              <th className="px-4 py-3 font-semibold" key={header}>
                {header}
              </th>
            ))}
            <th className="px-4 py-3 text-right font-semibold">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {rows.map((row, index) => (
            <tr
              className={cn(
                "transition hover:bg-muted/30",
                index === 1 && "bg-brand-teal-soft/25",
              )}
              key={index}
            >
              {row.map((cell, cellIndex) => (
                <td className="px-4 py-4 align-middle" key={cellIndex}>
                  {cell}
                </td>
              ))}
              <td className="px-4 py-4 text-right">
                <button
                  aria-label="Row actions"
                  className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                  type="button"
                >
                  <MoreVertical className="size-4" />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FormField({
  icon: Icon,
  label,
  name,
  placeholder,
  required,
  type = "text",
}: {
  icon?: IconComponent;
  label: string;
  name?: string;
  placeholder: string;
  required?: boolean;
  type?: string;
}) {
  return (
    <label className="block text-sm font-semibold text-foreground">
      {label}
      <span className="mt-2 flex h-12 items-center gap-3 rounded-lg border border-border bg-surface px-3 shadow-sm transition focus-within:border-brand-teal focus-within:ring-2 focus-within:ring-brand-teal/15">
        {Icon ? <Icon className="size-4 text-muted-foreground" /> : null}
        <input
          className="h-full w-full bg-transparent text-sm font-normal outline-none placeholder:text-muted-foreground"
          name={name}
          placeholder={placeholder}
          required={required}
          type={type}
        />
      </span>
    </label>
  );
}

export function PublicShell({
  active,
  children,
  footer = true,
}: {
  /*
   * Mirrors `PublicHeaderProps["active"]`. The four More-menu entries — About,
   * Contact, Terms, Privacy — were missing, so those pages could not tell the
   * header which item to highlight and the dropdown showed nothing selected.
   */
  active?:
    | "about"
    | "blog"
    | "browse"
    | "community"
    | "compare"
    | "contact"
    | "home"
    | "how-booking-works"
    | "jobs"
    | "map"
    | "offer-program"
    | "plans-pricing"
    | "privacy"
    | "providers"
    | "refund-policy"
    | "register-hostel"
    | "terms";
  children: ReactNode;
  /** The shared footer; off only for pages that fill the viewport, like the map. */
  footer?: boolean;
}) {
  return (
    <AnimatedPage className="min-h-screen overflow-x-clip bg-background text-foreground">
      <PublicHeader active={active} />
      <div className="pt-16">{children}</div>
      {footer ? <PublicFooter /> : null}
    </AnimatedPage>
  );
}

// Extra icons & hooks for advanced public features
import {
  ChevronRight,
  PhoneCall,
  ChevronUp,
  FileText,
  List,
  Eye,
  Trash2,
  Calendar,
  AlertCircle as AlertIcon,
  HelpCircle,
} from "@/components/icons";
import { useSearchParams } from "next/navigation";
import { PublicFooter } from "@/components/public-footer";

// Nepal Banner Illustration Graphic
export function NepalBannerGraphic() {
  return (
    <svg
      className="absolute right-0 bottom-0 h-full w-[45%] opacity-90 hidden md:block pointer-events-none"
      viewBox="0 0 500 200"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Mountains */}
      <path
        d="M-50 180 L100 80 L220 160 L380 50 L500 180"
        stroke="#0f766e"
        strokeWidth="1.5"
        strokeOpacity="0.15"
        fill="none"
      />
      <path
        d="M50 180 L200 90 L320 170 L450 70 L550 180"
        stroke="#0f766e"
        strokeWidth="1.5"
        strokeOpacity="0.25"
        fill="none"
      />

      {/* Bouddhanath Stupa */}
      <g stroke="#0f766e" strokeWidth="1.5" fill="none" strokeOpacity="0.7">
        <path d="M280 180 C280 135 360 135 360 180 Z" fill="#ccfbf1" fillOpacity="0.1" />
        <rect x="310" y="117" width="20" height="18" fill="#ccfbf1" fillOpacity="0.2" />
        <path d="M320 117 L320 75" strokeWidth="3" />
        <line x1="313" y1="112" x2="327" y2="112" strokeWidth="1.2" />
        <line x1="315" y1="106" x2="325" y2="106" strokeWidth="1.2" />
        <line x1="317" y1="100" x2="323" y2="100" strokeWidth="1.2" />
        <line x1="319" y1="94" x2="321" y2="94" strokeWidth="1.2" />
        <circle cx="320" cy="71" r="3" fill="#0f766e" />
        <path d="M314 125 C316 123 317 123 318 125" strokeWidth="1" />
        <circle cx="316" cy="126" r="0.7" fill="#0f766e" />
        <path d="M322 125 C324 123 325 123 326 125" strokeWidth="1" />
        <circle cx="324" cy="126" r="0.7" fill="#0f766e" />
        <path d="M320 127 L319.5 130" strokeWidth="1" />
      </g>

      {/* Pagoda Temple */}
      <g stroke="#0f766e" strokeWidth="1.5" fill="none" strokeOpacity="0.6">
        <rect
          x="410"
          y="140"
          width="60"
          height="40"
          rx="1"
          fill="#ccfbf1"
          fillOpacity="0.1"
        />
        <rect
          x="420"
          y="125"
          width="40"
          height="15"
          rx="1"
          fill="#ccfbf1"
          fillOpacity="0.15"
        />
        <path d="M395 125 L440 90 L485 125 Z" fill="#ccfbf1" fillOpacity="0.25" />
        <rect x="427" y="78" width="26" height="12" fill="#ccfbf1" fillOpacity="0.15" />
        <path d="M410 78 L440 50 L470 78 Z" fill="#ccfbf1" fillOpacity="0.3" />
        <path d="M440 50 L440 40" strokeWidth="2" />
        <circle cx="440" cy="38" r="3" fill="#0f766e" />
      </g>
    </svg>
  );
}

// Breadcrumbs component
export function Breadcrumbs({ items }: { items: { label: string; href?: string }[] }) {
  return (
    <nav className="mx-auto w-full max-w-[1360px] px-4 py-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs sm:px-6 font-semibold text-muted-foreground bg-background">
      {items.map((item, index) => (
        <span key={item.label} className="flex items-center gap-2">
          {index > 0 && <span className="text-muted-foreground/30 font-normal">/</span>}
          {item.href ? (
            <Link href={item.href} className="hover:text-brand-teal transition">
              {item.label}
            </Link>
          ) : (
            <span className="text-foreground font-bold">{item.label}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

/* Nearly every listing has these, so on a card they tell one hostel from no other. */
const EVERYWHERE_FACILITIES =
  /^(wi-?fi|internet|cctv|hot water|laundry|meals?|food|bedding|personal cupboard|shoe rack)/i;
const SHARING_SIZE: Record<string, number> = { double: 2, five: 5, four: 4, single: 1, six: 6, triple: 3 };
const HOSTEL_TYPE_LABEL: Record<HostelSummary["type"], string> = {
  boys: "Boys",
  "co-living": "Co-living",
  girls: "Girls",
};

/** "Single to 4-sharing", from the rate card's room names. */
function roomRange(roomTypes: string[]) {
  const sizes = roomTypes
    .map((name) => SHARING_SIZE[name.trim().split(/\s+/)[0].toLowerCase()])
    .filter(Boolean);

  if (sizes.length === 0) {
    return roomTypes.length > 0 ? `${roomTypes.length} room types` : null;
  }

  const label = (size: number) => (size === 1 ? "Single" : `${size}-sharing`);
  const low = Math.min(...sizes);
  const high = Math.max(...sizes);

  return low === high ? label(low) : `${label(low)} to ${high}-sharing`;
}

// HostelCard Component
export function HostelCard({ hostel }: { hostel: HostelSummary }) {
  const rooms = roomRange(hostel.roomTypes);
  const extras = hostel.facilities.filter((facility) => !EVERYWHERE_FACILITIES.test(facility));
  const facts = [
    { Icon: Users, label: HOSTEL_TYPE_LABEL[hostel.type] },
    rooms ? { Icon: BedDouble, label: rooms } : null,
    hostel.vacancyKnown === false
      ? null
      : { Icon: Building2, label: hostel.vacancy > 0 ? `${hostel.vacancy} beds free` : "Full" },
  ].filter((fact) => fact !== null);

  return (
    // Plain CSS hover, not framer-motion: rows of these sit under a scrolling
    // cursor, and a JS animation per card made the page stutter.
    <article className="group flex h-full flex-col overflow-hidden rounded-2xl border border-border/70 bg-surface shadow-sm transition-[transform,box-shadow] duration-200 hover:-translate-y-[3px] hover:shadow-md">
      <Link href={`/hostels/${hostel.slug}`} className="flex h-full flex-col">
        <div className="relative h-40 shrink-0 overflow-hidden">
          {/* Lazy and off-thread: a background image is fetched and decoded for
              every card at once, even the ones scrolled out of view. */}
          {/* eslint-disable-next-line @next/next/no-img-element -- authenticated-redirect file URLs, not optimizable */}
          <img
            alt=""
            className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-105"
            decoding="async"
            loading="lazy"
            src={optimizedImage(hostel.image, 640)}
          />
          <div className="absolute left-3 top-3 flex flex-wrap items-center gap-1.5">
            <StatusPill
              tone="success"
              className="border border-emerald-100/50 bg-emerald-50 px-2 py-0.5 text-[10px] font-bold text-emerald-700"
            >
              Verified
            </StatusPill>
            {hostel.listingTier ? <ListingTierBadge tier={hostel.listingTier} /> : null}
          </div>
          <button
            aria-label="Save hostel"
            className="absolute right-3 top-3 inline-flex size-8 items-center justify-center rounded-full bg-surface/85 text-muted-foreground transition hover:bg-surface hover:text-danger"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            type="button"
          >
            <Heart className="size-4" />
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-3 p-4">
          <div>
            <div className="flex items-start justify-between gap-2">
              <h3
                className="line-clamp-1 text-sm font-bold text-foreground transition group-hover:text-brand-teal"
                title={hostel.name}
              >
                {hostel.name}
              </h3>
              {hostel.reviews > 0 ? (
                <span className="inline-flex shrink-0 items-center gap-0.5 text-xs font-bold text-foreground">
                  <Star className="size-3.5 fill-warning text-warning" />
                  {hostel.rating}
                  <span className="text-[10px] font-normal text-muted-foreground">({hostel.reviews})</span>
                </span>
              ) : (
                <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[10px] font-semibold text-muted-foreground">
                  New
                </span>
              )}
            </div>
            <p className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
              <MapPin className="size-3 shrink-0" />
              <span className="line-clamp-1">
                {hostel.area}, {hostel.city}
              </span>
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5">
            {facts.map(({ Icon, label }) => (
              <span
                className="inline-flex items-center gap-1 rounded-md bg-muted/70 px-2 py-1 text-[10px] font-semibold text-foreground/80"
                key={label}
              >
                <Icon className="size-3 text-brand-teal" />
                {label}
              </span>
            ))}
          </div>

          <div className="mt-auto flex items-end justify-between gap-2 border-t border-border/50 pt-3">
            {/* No rent recorded is "ask", never "NPR 0". */}
            {hostel.price > 0 ? (
              <p className="text-sm font-extrabold text-foreground">
                {formatMoney(hostel.price)}
                <span className="text-[10px] font-normal text-muted-foreground"> / month</span>
              </p>
            ) : (
              <p className="text-xs font-bold text-muted-foreground">Ask for rent</p>
            )}
            {extras.length > 0 ? (
              <p className="line-clamp-1 text-right text-[10px] font-medium text-muted-foreground">
                {extras.slice(0, 2).join(" · ")}
                {extras.length > 2 ? ` · +${extras.length - 2}` : ""}
              </p>
            ) : null}
          </div>
        </div>
      </Link>
    </article>
  );
}

// HostelListCard Component for List View
export function HostelListCard({ hostel }: { hostel: HostelSummary }) {
  return (
    <motion.article
      className="group overflow-hidden rounded-xl border border-border/80 bg-surface shadow-sm hover:shadow-md transition-all flex flex-col md:flex-row h-full md:h-44"
      transition={{ duration: 0.2 }}
      whileHover={{ y: -2 }}
    >
      <Link
        href={`/hostels/${hostel.slug}`}
        className="relative h-44 w-full md:w-64 shrink-0 overflow-hidden"
      >
        <div
          className="h-full w-full bg-cover bg-center transition duration-500 group-hover:scale-105"
          style={{ backgroundImage: `url("${optimizedImage(hostel.image, 640)}")` }}
        />
        <div className="absolute left-3 top-3 flex flex-wrap items-center gap-1.5">
          <StatusPill
            tone="success"
            className="text-[10px] font-bold py-0.5 px-2 bg-emerald-50 text-emerald-700 border border-emerald-100/50"
          >
            Verified
          </StatusPill>
          {hostel.listingTier ? <ListingTierBadge tier={hostel.listingTier} /> : null}
        </div>
      </Link>
      <div className="flex-1 p-4 flex flex-col justify-between min-w-0">
        <div>
          <div className="flex items-start justify-between gap-3">
            <div>
              <Link href={`/hostels/${hostel.slug}`}>
                <h3 className="text-base font-bold text-foreground group-hover:text-brand-teal transition truncate">
                  {hostel.name}
                </h3>
              </Link>
              <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1 font-medium">
                <MapPin className="size-3.5" /> {hostel.area}, {hostel.city}
              </p>
            </div>
            <span className="inline-flex items-center gap-0.5 text-xs font-bold text-foreground shrink-0">
              <Star className="size-3.5 fill-warning text-warning" />
              {hostel.rating}{" "}
              <span className="text-[10px] font-normal text-muted-foreground">
                ({hostel.reviews})
              </span>
            </span>
          </div>
          <p className="mt-2 text-xs text-muted-foreground line-clamp-2 leading-relaxed">
            {hostel.description}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/50 pt-2.5 mt-2">
          {hostel.price > 0 ? (
            <div className="flex items-baseline gap-1.5">
              <span className="text-base font-extrabold text-foreground">
                {formatMoney(hostel.price)}
              </span>
              <span className="text-[10px] font-normal text-muted-foreground">/ month</span>
            </div>
          ) : (
            <span className="text-xs font-bold text-muted-foreground">Ask for rent</span>
          )}
          <div className="flex items-center gap-3 text-[10px] font-semibold text-muted-foreground">
            <span className="flex items-center gap-1">
              <Building2 className="size-3.5 text-muted-foreground/80" />
              Vacant {hostel.vacancy}
            </span>
            <span className="flex items-center gap-1">
              <Wifi className="size-3.5 text-muted-foreground/80" />
              Wi-Fi
            </span>
            <span className="flex items-center gap-1">
              <Utensils className="size-3.5 text-muted-foreground/80" />
              Food
            </span>
          </div>
        </div>
      </div>
    </motion.article>
  );
}
