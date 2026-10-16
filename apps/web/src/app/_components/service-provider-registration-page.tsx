"use client";

import {
  ArrowRight,
  BadgeCheck,
  Banknote,
  Briefcase,
  Brush,
  CalendarDays,
  Check,
  CheckCircle2,
  Clock,
  Droplet,
  FileText,
  Hammer,
  IdCard,
  Mail,
  MapPin,
  Paintbrush,
  Phone,
  Plug,
  Router,
  Smartphone,
  Sparkles,
  Stethoscope,
  Trash2,
  UserRound,
  Wrench,
  X,
  type IconComponent,
} from "@/components/icons";
import Image from "next/image";
import Link from "next/link";
import { Suspense, useCallback, useEffect, useState, type FormEvent } from "react";

import { GoogleAuthButton } from "@/app/(auth)/google-auth-button";
import { FileUploaderView, useUploader } from "@/components/uploads";
import { browserApi } from "@/lib/browser-api";
import { checkAuthWithRefresh } from "@/lib/auth-check";
import { cn } from "@/lib/utils";
import { MOCKUPS } from "./portal-mockups";
import { PublicShell } from "./shared";
import { SiteName, useSiteConfig } from "@/components/site-config-provider";
import { contentIcon, resolveContentPage } from "@/lib/site-content";
import { useConfirm } from "@/app/_components/confirm-dialog";
import { useHasResidentIdCard } from "@/lib/use-resident-id-card";

/**
 * Public service-provider registration (PHASES.md §6.1 "Service Provider Mobile
 * App"). Two steps, in the order the phase plan requires:
 *
 *  1. Google sign-in — the gate exists so the email on the application is one
 *     Google has verified. Approval later upgrades *that* account from PUBLIC to
 *     SERVICE_PROVIDER, so a self-typed address would break the upgrade.
 *  2. Trade details — everything else, with the email locked to the identity
 *     from step 1.
 *
 * There is deliberately no provider dashboard on the web: an approved provider
 * works out of the mobile app, and this page says so.
 */

const CATEGORIES = [
  "PLUMBER",
  "ELECTRICIAN",
  "DOCTOR_CLINIC",
  "INTERNET_TECHNICIAN",
  "CLEANER",
  "CARPENTER",
  "PAINTER",
  "WATER_SUPPLIER",
  "APPLIANCE_REPAIR",
  "ROOM_REPAIR",
  "OTHER",
] as const;

/**
 * The hero's pale wash, mixed from the brand token rather than written as hex
 * so it stays correct if the brand green is ever retuned — and so dark mode
 * gets the same wash against `--background` instead of a light band that glows.
 */
/**
 * Inlined at build time, like every `NEXT_PUBLIC_` value read from a client
 * component: empty on a deployment where Google sign-in was never configured.
 */
const googleClientId = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

/**
 * Where the signed-out card sends a tradesperson when Google sign-in is not
 * configured on this deployment. `next` brings them straight back here, so the
 * application picks up on the same card they left rather than on whatever
 * dashboard their role happens to land on.
 */
const SIGN_IN_HREF = `/login?next=${encodeURIComponent("/service-providers")}`;

const HERO_WASH =
  "bg-[linear-gradient(135deg,color-mix(in_srgb,var(--brand-teal)_10%,var(--background))_0%,var(--background)_45%,color-mix(in_srgb,var(--brand-teal)_14%,var(--background))_100%)]";

/**
 * The photograph behind the hero, drawn as a **background image** rather than an
 * `<img>` on purpose: it is decorative, it carries no information the copy does
 * not already carry, and a missing file then costs nothing. A broken-image icon
 * sitting in the middle of the landing page is a worse failure than no
 * photograph at all, and this file is an art asset that can go missing in a
 * deploy without anybody noticing until a visitor sees it.
 *
 * Drop the asset at `apps/web/public/service-provider-hero.png`.
 */
const HERO_IMAGE = "/service-provider-hero.png";

/** The 11 trades, in the order the enum declares them, with a face each. */
const TRADE_ICONS: Record<(typeof CATEGORIES)[number], IconComponent> = {
  APPLIANCE_REPAIR: Plug,
  CARPENTER: Hammer,
  CLEANER: Trash2,
  DOCTOR_CLINIC: Stethoscope,
  ELECTRICIAN: Plug,
  INTERNET_TECHNICIAN: Router,
  OTHER: Sparkles,
  PAINTER: Paintbrush,
  PLUMBER: Wrench,
  ROOM_REPAIR: Brush,
  WATER_SUPPLIER: Droplet,
};

/**
 * Renders `*asterisked*` runs of a config string in the brand green.
 *
 * The headline lives in Website Config so an owner can rewrite it, but the
 * mockup paints one word of it green, and an owner who rewrites the sentence
 * would otherwise lose that emphasis or be asked to type HTML into a text
 * field. One character of markup is the cheapest thing that survives both.
 */
function renderEmphasis(text: string) {
  return text.split(/\*([^*]+)\*/g).map((part, index) =>
    index % 2 === 1 ? (
      <span className="text-brand-teal" key={index}>
        {part}
      </span>
    ) : (
      part
    ),
  );
}

const FIELD_SHELL =
  "mt-2 flex h-12 items-center gap-3 rounded-xl border border-border bg-surface px-3 shadow-sm transition focus-within:border-brand-teal focus-within:ring-2 focus-within:ring-brand-teal/15";
const FIELD_INPUT =
  "h-full w-full bg-transparent text-sm font-normal outline-none placeholder:text-muted-foreground";
const LABEL = "block text-sm font-semibold text-foreground";

type SessionUser = {
  email: string | null;
  name: string;
  phone: string | null;
  role: string;
};

type MeResponse = {
  success: boolean;
  data?: { user: SessionUser };
};

type ProviderStatus =
  "PENDING_APPROVAL" | "APPROVED" | "REJECTED" | "HIDDEN" | "INACTIVE";

/** The hero's live numbers, measured by `getPublicServiceProviderStats`. */
type ProviderStats = {
  areaCount: number;
  /** `null` until at least one provider has been approved. */
  medianApprovalDays: number | null;
  totalProviders: number;
};

/** The caller's own application, as returned by `/public/service-providers/me`. */
type OwnApplication = {
  area: string;
  availability: string;
  categories: string[];
  category: string;
  city: string;
  description: string;
  documentCount: number;
  email: string;
  experience: string;
  fullName: string;
  id: string;
  phone: string;
  rejectionReason: string;
  status: ProviderStatus;
  submittedAt?: string;
};

/** A REJECTED applicant may apply again; every other status is still in play. */
function isApplicationOpen(status: ProviderStatus) {
  return status !== "REJECTED";
}

function categoryLabel(category: string) {
  return category
    .split("_")
    .map((word) => word.charAt(0) + word.slice(1).toLowerCase())
    .join(" ");
}

/** One of the hero's live numbers, in its own bordered tile. */
function StatCard({
  icon: Icon,
  label,
  value,
}: {
  icon: IconComponent;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-border bg-card/70 px-4 py-3 backdrop-blur-sm">
      <Icon aria-hidden className="size-5 shrink-0 text-brand-teal" />
      <div className="min-w-0">
        <div className="text-lg leading-tight font-extrabold text-foreground">
          {value}
        </div>
        <div className="text-[11px] leading-snug text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

/** A short claim beside the headline — icon, two or three words, no box. */
function HeroPill({ icon: Icon, label }: { icon: IconComponent; label: string }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-border bg-card/70 px-3.5 py-2 text-[13px] font-semibold text-foreground backdrop-blur-sm">
      <Icon aria-hidden className="size-4 text-brand-teal" />
      {label}
    </span>
  );
}

/**
 * One of the sample job cards floating over the hero photograph.
 *
 * These are illustrations of a real job's fields — trade, priority, what broke —
 * and they are marked `aria-hidden` because a screen reader announcing three
 * fake maintenance requests as page content would be a lie told in the one
 * place a sighted visitor can see is decoration.
 */
function FloatingJobCard({
  className,
  priority,
  title,
  trade,
}: {
  className: string;
  priority: "High" | "Medium" | "Urgent";
  title: string;
  trade: string;
}) {
  const tone =
    priority === "Urgent"
      ? "bg-destructive/10 text-destructive"
      : priority === "High"
        ? "bg-warning/15 text-warning"
        : "bg-muted text-muted-foreground";

  return (
    <div
      aria-hidden
      className={`pointer-events-none absolute w-[172px] rounded-2xl border border-border bg-card/95 p-3 shadow-lg backdrop-blur-sm ${className}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[13px] font-bold text-foreground">{trade}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${tone}`}>
          {priority}
        </span>
      </div>
      <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{title}</p>
      <p className="mt-2 text-[10px] font-semibold text-brand-teal">Hostel request</p>
    </div>
  );
}

/** One of the four "what you get" cards under the hero. */
function ValueCard({
  badge,
  body,
  children,
  icon: Icon,
  title,
}: {
  badge: string;
  body: string;
  children?: React.ReactNode;
  icon: IconComponent;
  title: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-5 transition hover:border-brand-teal/40">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-teal-soft text-brand-teal">
          <Icon aria-hidden className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-[15px] font-bold text-foreground">{title}</h3>
            <span className="rounded-full bg-brand-teal-soft px-2 py-0.5 text-[10px] font-semibold text-brand-teal">
              {badge}
            </span>
          </div>
          <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{body}</p>
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * The hero's stat row, which has to survive an almost-empty directory.
 *
 * The page this replaces led with "**2** registered providers", which told
 * every visitor the network was dead — the single most damaging element on it.
 * So a stat only appears once it is worth showing: below `MIN_PROVIDERS_TO_SHOW`
 * the provider count is replaced by the trade coverage, which is 11 on day one
 * and true forever. Nothing here is fabricated; the small number is withheld,
 * not dressed up.
 */
const MIN_PROVIDERS_TO_SHOW = 12;
const MIN_AREAS_TO_SHOW = 4;

function HeroStats({ stats }: { stats?: ProviderStats }) {
  const cards: { icon: IconComponent; label: string; value: string }[] = [];

  if (stats && stats.totalProviders >= MIN_PROVIDERS_TO_SHOW) {
    cards.push({
      icon: UserRound,
      label: "Approved Providers",
      value: `${stats.totalProviders}+`,
    });
  }

  if (stats && stats.areaCount >= MIN_AREAS_TO_SHOW) {
    cards.push({
      icon: MapPin,
      label: "Areas Covered",
      value: String(stats.areaCount),
    });
  }

  if (stats && stats.medianApprovalDays !== null) {
    const days = Math.max(1, Math.round(stats.medianApprovalDays));

    cards.push({
      icon: Clock,
      label: "Median Approval Time",
      value:
        stats.medianApprovalDays < 1
          ? "Same day"
          : `${days} ${days === 1 ? "day" : "days"}`,
    });
  }

  // Backfilled, never padded — every one of these is a fact about the product
  // rather than a measurement of a table that may still be empty.
  if (cards.length < 3) {
    cards.unshift({
      icon: Briefcase,
      label: "Trades Covered",
      value: String(CATEGORIES.length),
    });
  }

  if (cards.length < 3) {
    cards.push({ icon: Banknote, label: "Joining Fee", value: "Free" });
  }

  if (cards.length < 3) {
    cards.push({ icon: MapPin, label: "Coverage", value: "All Nepal" });
  }

  return (
    <div className="mt-8 grid gap-3 sm:grid-cols-3">
      {cards.slice(0, 3).map((card) => (
        <StatCard
          icon={card.icon}
          key={card.label}
          label={card.label}
          value={card.value}
        />
      ))}
    </div>
  );
}

/**
 * How long review takes, stated once on this surface.
 *
 * Its twin is `PROVIDER_REVIEW_WINDOW` in
 * `apps/mobile/src/lib/provider-status.ts`. Copied rather than imported for the
 * reason `admin-manage-api.ts` copies the pricing vocabulary: `@hostel/shared`
 * does not resolve inside the phone bundle — Metro aliases exactly one file out
 * of it — so a value the two surfaces must agree on is written in both with a
 * pointer, not hoisted into a package one of them cannot reach.
 *
 * It is a promise made to a tradesperson who has handed over their documents
 * and their face, and it is the one question they have while waiting. If it
 * changes, it changes in both.
 */
const PROVIDER_REVIEW_WINDOW = "1–2 business days";

const STATUS_PANEL: Record<
  ProviderStatus,
  { body: string; heading: string; tone: "info" | "success" | "warning" }
> = {
  APPROVED: {
    body: "You're listed as a verified provider. Hostels can now send you jobs, and they arrive in the mobile app — signed in with this same account, which becomes a provider account on its own. There are no separate credentials.",
    heading: "Approved",
    tone: "success",
  },
  HIDDEN: {
    body: "Your listing is temporarily hidden by the platform, so hostels cannot find you or send you work right now. Contact support if this is unexpected.",
    heading: "Listing hidden",
    tone: "warning",
  },
  INACTIVE: {
    body: "Your listing is marked inactive, so hostels cannot find you or send you work. Contact support to reactivate it.",
    heading: "Listing inactive",
    tone: "warning",
  },
  PENDING_APPROVAL: {
    body: `We're verifying your details and documents. It usually takes ${PROVIDER_REVIEW_WINDOW} — we'll email you the moment there's a decision.`,
    heading: "Under review",
    tone: "info",
  },
  REJECTED: {
    body: "Your application wasn't approved. You can correct the details and submit again.",
    heading: "Not approved",
    tone: "warning",
  },
};

const STATUS_TONE = {
  info: "border-brand-teal/30 bg-brand-teal-soft text-brand-teal",
  success: "border-success/30 bg-success/10 text-success",
  warning: "border-warning/30 bg-warning/10 text-warning",
} as const;

/** Shown in place of the CTA once the signed-in account already has an application. */
function ApplicationStatusPanel({
  application,
  onReapply,
  onViewDetails,
}: {
  application: OwnApplication;
  onReapply: () => void;
  onViewDetails: () => void;
}) {
  const panel = STATUS_PANEL[application.status];

  return (
    <div className="mt-5">
      <div
        className={`flex items-center gap-2 rounded-xl border px-4 py-3 text-sm font-bold ${STATUS_TONE[panel.tone]}`}
      >
        {application.status === "APPROVED" ? (
          <BadgeCheck className="size-5 shrink-0" />
        ) : (
          <Clock className="size-5 shrink-0" />
        )}
        {panel.heading}
      </div>

      <p className="mt-4 text-[13px] leading-relaxed text-muted-foreground">
        {panel.body}
      </p>

      {application.rejectionReason ? (
        <p className="mt-3 rounded-xl border border-border bg-muted/40 px-4 py-3 text-[13px] leading-relaxed text-muted-foreground">
          <strong className="text-foreground">Reason:</strong>{" "}
          {application.rejectionReason}
        </p>
      ) : null}

      <dl className="mt-5 grid grid-cols-2 gap-4 text-[13px]">
        <div>
          <dt className="text-muted-foreground">
            {application.categories.length > 1 ? "Trades" : "Trade"}
          </dt>
          <dd className="mt-0.5 font-semibold text-foreground">
            {application.categories.map(categoryLabel).join(", ")}
          </dd>
        </div>
        <div>
          <dt className="text-muted-foreground">Area</dt>
          <dd className="mt-0.5 font-semibold text-foreground">
            {application.area}, {application.city}
          </dd>
        </div>
        {application.submittedAt ? (
          <div>
            <dt className="text-muted-foreground">Submitted</dt>
            <dd className="mt-0.5 font-semibold text-foreground">
              {new Date(application.submittedAt).toLocaleDateString()}
            </dd>
          </div>
        ) : null}
      </dl>

      <button
        className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-border px-5 py-3 text-sm font-semibold text-foreground transition hover:border-brand-teal hover:text-brand-teal"
        onClick={onViewDetails}
        type="button"
      >
        <FileText className="size-4" />
        View submitted details
      </button>

      {application.status === "REJECTED" ? (
        <button
          className="mt-3 flex w-full items-center justify-center gap-2 rounded-xl bg-brand-teal px-5 py-3.5 text-[15px] font-bold text-white transition hover:opacity-95"
          onClick={onReapply}
          type="button"
        >
          Apply again
          <ArrowRight className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/** Read-only replay of exactly what the applicant submitted. */
function SubmittedDetailsDialog({
  application,
  onClose,
}: {
  application: OwnApplication;
  onClose: () => void;
}) {
  const rows: { label: string; value: string }[] = [
    { label: "Full name", value: application.fullName },
    { label: "Phone", value: application.phone },
    { label: "Email", value: application.email || "—" },
    {
      label: application.categories.length > 1 ? "Trades" : "Trade",
      value: application.categories.map(categoryLabel).join(", "),
    },
    { label: "Area", value: `${application.area}, ${application.city}` },
    { label: "Availability", value: application.availability || "—" },
    { label: "Experience", value: application.experience || "—" },
    { label: "Description", value: application.description || "—" },
    {
      label: "Attachments",
      value:
        application.documentCount === 1 ? "1 file" : `${application.documentCount} files`,
    },
  ];

  return (
    <div
      className="fixed inset-0 z-50 grid place-items-center bg-black/50 p-4"
      onClick={onClose}
      role="presentation"
    >
      <div
        aria-labelledby="submitted-details-title"
        aria-modal="true"
        className="max-h-[85dvh] w-full max-w-[560px] overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-xl sm:p-8"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3
              className="font-heading text-xl font-bold text-foreground"
              id="submitted-details-title"
            >
              Your submitted details
            </h3>
            <p className="mt-1 text-[13px] text-muted-foreground">
              This is what our team is reviewing.
            </p>
          </div>
          <button
            aria-label="Close"
            className="rounded-lg p-1 text-muted-foreground transition hover:bg-muted"
            onClick={onClose}
            type="button"
          >
            <X className="size-5" />
          </button>
        </div>

        <dl className="mt-6 divide-y divide-border">
          {rows.map((row) => (
            <div className="grid grid-cols-[130px_1fr] gap-4 py-3" key={row.label}>
              <dt className="text-[13px] text-muted-foreground">{row.label}</dt>
              <dd className="text-[13px] font-medium break-words text-foreground">
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}

/**
 * Step 1 — the split hero, and the entry point for everyone. Pitch and live
 * numbers on the left; on the right the Google gate (signed out), the caller's
 * application status (already applied), or a straight "continue" into the form.
 * A signed-in visitor still gets the pitch — the landing page is what sells the
 * network, so it is never skipped just because a session exists.
 */
function LandingStep({
  application,
  isApplicationLoading,
  onContinue,
  stats,
  user,
}: {
  application: OwnApplication | null;
  isApplicationLoading: boolean;
  onContinue: () => void;
  stats?: ProviderStats;
  user: SessionUser | null;
}) {
  const [error, setError] = useState("");
  const [isDetailsOpen, setIsDetailsOpen] = useState(false);
  /*
   * The hero's words come from Platform → Website Config → Page Content, so the
   * pitch a tradesperson reads here is the pitch they read on the app's Service
   * providers screen. The stats beside it stay computed — a registered-provider
   * count typed into a config field would be a number that stops being true.
   */
  const { content, identity } = useSiteConfig();
  const page = resolveContentPage(content.serviceProviders, identity);
  // The button reports the signed-in user, but this page re-reads the session
  // itself on mount — a full reload is the simplest way to come back with the
  // cookie definitely in place.
  const handleSuccess = useCallback(() => {
    window.location.reload();
  }, []);

  return (
    <>
      {/* ── Hero ────────────────────────────────────────────────────────────
          Three columns on a wide screen — pitch, photograph, sign-up card —
          collapsing to one on a phone, where the photograph drops out entirely
          rather than pushing the CTA below two screenfuls of decoration. */}
      <section className="relative isolate overflow-hidden">
        {/*
          The hero ground, in three stacked layers.

          The art asset is one wide image — a pale green wash on the left, a
          tradesperson and a hostel on the right — drawn as a **background**
          rather than an `<img>` so the copy can sit on top of its empty half
          exactly as the mockup composes it, and so a missing file degrades to
          the wash beneath instead of a broken-image icon across the hero.

          `HERO_WASH` sits under the photograph on purpose: it is what the hero
          looks like before the image loads, on the narrow screens where the
          image is deliberately not painted, and if the asset ever goes missing
          in a deploy.
        */}
        <div aria-hidden className={`absolute inset-0 -z-30 ${HERO_WASH}`} />
        <div
          aria-hidden
          className="absolute inset-0 -z-20 hidden bg-[position:right_top] bg-[length:150%_auto] bg-no-repeat md:block lg:bg-[length:134%_auto] xl:bg-[length:124%_auto] 2xl:bg-[length:112%_auto]"
          style={{ backgroundImage: `url("${HERO_IMAGE}")` }}
        />
        {/*
          Readability scrim, and it is deliberately faint in light mode.

          The asset already carries its own pale wash on the left — it was
          drawn with an empty half for exactly this copy — so a strong scrim
          flattens the art it is meant to protect. This is a light veil that
          only firms up the contrast under the paragraph and fades out before
          it reaches the person.

          Dark mode is the opposite problem: the same asset is a bright slab in
          a dark page, so there the scrim is heavy and runs the full width.
        */}
        <div
          aria-hidden
          className="absolute inset-0 -z-10 bg-[linear-gradient(90deg,color-mix(in_srgb,var(--background)_55%,transparent)_0%,color-mix(in_srgb,var(--background)_25%,transparent)_30%,transparent_52%)] dark:bg-[linear-gradient(90deg,var(--background)_0%,color-mix(in_srgb,var(--background)_88%,transparent)_45%,color-mix(in_srgb,var(--background)_62%,transparent)_100%)]"
        />

        <div className="mx-auto grid max-w-[1400px] items-center gap-10 px-6 py-10 sm:px-10 lg:grid-cols-[minmax(0,1fr)_370px] lg:gap-8 lg:py-20 xl:px-16">
          <div className="max-w-[620px]">
            <span className="inline-flex items-center gap-2 rounded-full border border-brand-teal/25 bg-brand-teal-soft px-3.5 py-1.5 text-[13px] font-semibold text-brand-teal">
              <BadgeCheck aria-hidden className="size-4" />
              Verified service provider network
            </span>

            <h1 className="mt-5 max-w-[540px] font-heading text-[clamp(1.85rem,3vw,2.5rem)] leading-[1.16] font-extrabold text-foreground">
              {renderEmphasis(page.subtitle)}
            </h1>

            <p className="mt-5 max-w-[500px] text-[clamp(0.95rem,1.2vw,1.1rem)] leading-relaxed text-muted-foreground">
              {page.intro[0]}
            </p>

            <div className="mt-7 flex flex-wrap gap-2.5">
              <HeroPill icon={Briefcase} label="More work" />
              <HeroPill icon={BadgeCheck} label="Verified identity" />
              <HeroPill icon={Banknote} label="No joining fee" />
              <HeroPill icon={MapPin} label="All over Nepal" />
            </div>

            <HeroStats stats={stats} />
          </div>

          {/*
            The sample job cards, floated over the photograph between the copy
            and the sign-up card. Only from `xl` up: below that the gap they
            live in closes and they would land on the person's face or on the
            headline. They are decoration, so losing them costs nothing.
          */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 hidden xl:block"
          >
            <FloatingJobCard
              className="top-[14%] left-[41%]"
              priority="Urgent"
              title="Water leaking in 2 rooms"
              trade="Plumbing"
            />
            <FloatingJobCard
              className="top-[43%] left-[37%]"
              priority="High"
              title="Socket not working"
              trade="Electrical"
            />
            <FloatingJobCard
              className="top-[24%] left-[55%]"
              priority="Medium"
              title="Broken cabinet"
              trade="Carpentry"
            />
            <div className="absolute top-[72%] left-[43%] flex items-center gap-2 rounded-full border border-border bg-card/95 px-4 py-2 text-[12px] font-semibold text-foreground shadow-lg backdrop-blur-sm">
              <BadgeCheck className="size-4 text-brand-teal" />
              Work with verified hostels
            </div>
          </div>

          {/* The sign-up card. Ordered first on a phone: a tradesperson who
              already knows why they are here should not have to scroll past
              the pitch to reach the button. */}
          <div className="order-first w-full rounded-3xl border border-border bg-card/95 p-6 shadow-xl backdrop-blur-sm sm:p-8 lg:order-none">
            <h2 className="text-center font-heading text-[24px] font-bold text-foreground">
              {!user
                ? "Create your provider account"
                : application
                  ? "Your application"
                  : "Become a service provider"}
            </h2>

            {error ? (
              <p
                aria-live="polite"
                className="mt-4 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive"
              >
                {error}
              </p>
            ) : null}

            {user ? (
              <>
                <div className="mt-5 flex items-center gap-3 rounded-xl border border-border bg-muted/40 px-4 py-3">
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-brand-teal-soft text-sm font-bold text-brand-teal">
                    {(user.name || user.email || "?").charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-semibold text-foreground">
                      {user.name || "Signed in"}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {user.email ?? "Signed in"}
                    </span>
                  </span>
                </div>

                {isApplicationLoading ? (
                  <div className="mt-5 h-[52px] animate-pulse rounded-xl bg-muted/60" />
                ) : application ? (
                  <>
                    <ApplicationStatusPanel
                      application={application}
                      onReapply={onContinue}
                      onViewDetails={() => setIsDetailsOpen(true)}
                    />
                    {isDetailsOpen ? (
                      <SubmittedDetailsDialog
                        application={application}
                        onClose={() => setIsDetailsOpen(false)}
                      />
                    ) : null}
                  </>
                ) : (
                  <>
                    <button
                      className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-brand-teal px-5 py-3.5 text-[15px] font-bold text-white transition hover:opacity-95"
                      onClick={onContinue}
                      type="button"
                    >
                      Continue — become a service provider
                      <ArrowRight className="size-4" />
                    </button>

                    <p className="mt-4 text-center text-[13px] text-muted-foreground">
                      Next you&apos;ll fill out your trade details
                    </p>
                  </>
                )}
              </>
            ) : (
              <>
                <p className="mt-1 text-center text-[13px] text-muted-foreground">
                  Takes 2–3 minutes. No payment required.
                </p>

                <div className="mt-6">
                  {googleClientId ? (
                    <GoogleAuthButton
                      clientId={googleClientId}
                      onError={setError}
                      onSuccess={handleSuccess}
                    />
                  ) : (
                    /*
                      No Google client id on this deployment. Offering a button
                      whose only job is to explain that it does not work is a
                      dead end on the one page whose whole purpose is signing
                      up, so the card falls back to the email login — which
                      sends the tradesperson straight back here afterwards.
                    */
                    <Link
                      className="flex w-full items-center justify-center gap-2 rounded-xl bg-brand-teal px-5 py-3.5 text-[15px] font-bold text-white transition hover:opacity-95"
                      href={SIGN_IN_HREF}
                    >
                      Sign in to continue
                      <ArrowRight className="size-4" />
                    </Link>
                  )}
                </div>

                <p className="mt-4 text-center text-[13px] text-muted-foreground">
                  You&apos;ll fill out your trade details after signing in
                </p>

                <ul className="mt-5 flex flex-wrap justify-center gap-x-4 gap-y-2">
                  {["Free to join", "Verified by our team", "Get work via app"].map(
                    (item) => (
                      <li
                        className="flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground"
                        key={item}
                      >
                        <Check aria-hidden className="size-3.5 text-brand-teal" />
                        {item}
                      </li>
                    ),
                  )}
                </ul>
              </>
            )}

            <div className="my-7 h-px bg-border" />

            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {page.noteBody}
            </p>

            {user ? null : (
              <p className="mt-7 text-center text-[13px] text-muted-foreground">
                Already registered?{" "}
                <Link className="font-semibold text-brand-teal" href={SIGN_IN_HREF}>
                  Log in
                </Link>
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ── What you get ──────────────────────────────────────────────────── */}
      <section className="mx-auto max-w-[1400px] px-6 py-16 sm:px-10 xl:px-16">
        <h2 className="text-center font-heading text-[clamp(1.4rem,2.4vw,1.85rem)] font-extrabold text-foreground">
          Work the way you already do — we bring you the jobs
        </h2>
        <p className="mx-auto mt-3 max-w-[620px] text-center text-[15px] leading-relaxed text-muted-foreground">
          {page.intro[1]}
        </p>

        <div className="mt-10 grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <ValueCard
            badge="Your skills, all listed"
            body={`Register for one trade or all ${CATEGORIES.length}. Plumber and carpenter? Both get you found.`}
            icon={Wrench}
            title={`Choose up to ${CATEGORIES.length} trades`}
          >
            <div className="mt-3 flex flex-wrap gap-1.5">
              {["Plumber", "Electrician", "Cleaner"].map((trade) => (
                <span
                  className="rounded-lg border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                  key={trade}
                >
                  {trade}
                </span>
              ))}
              <span className="rounded-lg bg-muted px-2 py-0.5 text-[11px] font-semibold text-foreground">
                + {CATEGORIES.length - 3} more
              </span>
            </div>
          </ValueCard>

          {/*
            Deliberately not "earnings" or a wallet: no money moves through the
            platform, so the honest claim is that the hostel pays the provider
            and we take nothing out of it.
          */}
          <ValueCard
            badge="You set the quote"
            body="Contact the hostel, agree the work and the price with them, and get paid directly. We take no cut."
            icon={Banknote}
            title="Get paid directly"
          />

          <ValueCard
            badge="Simple & easy"
            body="See the job, hear the hostel's voice note, call them, and mark it contacted or completed — all from your phone."
            icon={Smartphone}
            title="Manage from mobile app"
          />

          <ValueCard
            badge="Show your verified status"
            body="Approved providers are emailed a Provider Identity Card with a QR code to show at the hostel gate."
            icon={IdCard}
            title="Official Provider ID Card"
          />
        </div>

        {/* The trade strip — the 11 real enum values, so a visitor can find
            their own trade in the list before they commit to signing in. */}
        <div className="mt-8 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border border-border bg-card px-5 py-4">
          <span className="text-[13px] font-bold text-foreground">
            {CATEGORIES.length} trades available:
          </span>
          {CATEGORIES.map((category) => {
            const Icon = TRADE_ICONS[category];

            return (
              <span
                className="inline-flex items-center gap-1.5 text-[13px] text-muted-foreground"
                key={category}
              >
                <Icon aria-hidden className="size-4 text-brand-teal" />
                {categoryLabel(category)}
              </span>
            );
          })}
        </div>
      </section>

      {/* ── How it works ──────────────────────────────────────────────────── */}
      <section className="border-y border-border bg-muted/30">
        <div className="mx-auto max-w-[1400px] px-6 py-16 sm:px-10 xl:px-16">
          <div className="grid gap-8 lg:grid-cols-[1fr_360px] lg:gap-12">
            <div>
              <h2 className="font-heading text-[clamp(1.4rem,2.4vw,1.85rem)] font-extrabold text-foreground">
                How it works
              </h2>

              <ol className="mt-8 grid gap-4 sm:grid-cols-2">
                {page.sections.map((section, index) => {
                  const Icon = contentIcon(section.icon);

                  return (
                    <li
                      className="rounded-2xl border border-border bg-card p-5"
                      key={section.title}
                    >
                      <div className="flex items-center gap-3">
                        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-brand-teal text-[13px] font-bold text-white">
                          {index + 1}
                        </span>
                        <Icon aria-hidden className="size-5 text-brand-teal" />
                        <h3 className="text-[15px] font-bold text-foreground">
                          {section.title}
                        </h3>
                      </div>
                      {section.body.map((line) => (
                        <p
                          className="mt-3 text-[13px] leading-relaxed text-muted-foreground"
                          key={line}
                        >
                          {line}
                        </p>
                      ))}
                    </li>
                  );
                })}
              </ol>

              <p className="mt-4 flex items-center gap-2 rounded-xl border border-border bg-card px-4 py-3 text-[13px] text-muted-foreground">
                <BadgeCheck aria-hidden className="size-4 shrink-0 text-brand-teal" />
                Not approved? You&apos;ll get a written reason — fix it and apply again.
              </p>

              {/* Where a job comes from: a resident reports it, the hostel sends it. */}
              <div className="mt-8 grid gap-4 sm:grid-cols-2">
                {[
                  { image: MOCKUPS.residentPortal, label: "A resident reports what is broken" },
                  { image: MOCKUPS.wardenDashboard, label: "The hostel sends the job to you" },
                ].map(({ image, label }) => (
                  <figure
                    className="rounded-2xl border border-border bg-card p-4"
                    key={image.src}
                  >
                    <div className="relative aspect-[3/2]">
                      <Image
                        alt={image.alt}
                        className="object-contain"
                        fill
                        sizes="(min-width: 1024px) 420px, (min-width: 640px) 50vw, 100vw"
                        src={image.src}
                      />
                    </div>
                    <figcaption className="mt-3 text-[13px] font-bold text-foreground">
                      {label}
                    </figcaption>
                  </figure>
                ))}
              </div>
            </div>

            {/*
              The app is described, not linked. There are no store listings for
              the Provider app anywhere in this codebase, and a Play badge that
              goes nowhere is a worse first impression than no badge — so this
              says how the app is reached, which is by email on approval.
            */}
            <div className="rounded-2xl border border-border bg-card p-6">
              <span className="grid size-11 place-items-center rounded-xl bg-brand-teal-soft text-brand-teal">
                <Smartphone aria-hidden className="size-6" />
              </span>
              <h3 className="mt-4 font-heading text-[18px] font-bold text-foreground">
                The Provider app
              </h3>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">
                All your jobs in your pocket. There is no website to log into and no
                laptop needed.
              </p>

              <ul className="mt-5 space-y-3">
                {[
                  "Every job a hostel sends you, newest first",
                  "The hostel's name, area and phone number",
                  "A voice note describing the fault, so you know what to bring",
                  "Mark a job contacted or completed in one tap",
                ].map((item) => (
                  <li
                    className="flex gap-2.5 text-[13px] text-muted-foreground"
                    key={item}
                  >
                    <Check
                      aria-hidden
                      className="mt-0.5 size-4 shrink-0 text-brand-teal"
                    />
                    {item}
                  </li>
                ))}
              </ul>

              <p className="mt-5 rounded-xl bg-muted/60 px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
                We email you how to get the app once your application is approved.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── Closing CTA ───────────────────────────────────────────────────── */}
      <section className="bg-brand-teal">
        <div className="mx-auto flex max-w-[1400px] flex-col items-center gap-5 px-6 py-10 text-center sm:px-10 lg:flex-row lg:justify-between lg:text-left xl:px-16">
          <div>
            <h2 className="font-heading text-[20px] font-extrabold text-white">
              Join a growing network of trusted service providers
            </h2>
            <p className="mt-1 text-[14px] text-white/80">
              More work. More respect. More income.
            </p>
          </div>
          <a
            className="inline-flex shrink-0 items-center gap-2 rounded-xl bg-white px-6 py-3.5 text-[15px] font-bold text-brand-teal transition hover:opacity-90"
            href="#top"
            onClick={(event) => {
              event.preventDefault();
              window.scrollTo({ behavior: "smooth", top: 0 });
            }}
          >
            {user && !application ? "Complete your application" : "Create your account"}
            <ArrowRight aria-hidden className="size-4" />
          </a>
        </div>
      </section>
    </>
  );
}

/** Step 2 — trade details. Email is fixed to the Google identity from step 1. */
function TradeDetailsStep({
  onSubmitted,
  user,
}: {
  onSubmitted: () => void;
  user: SessionUser;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  // Trades are multi-select — a local tradesperson is commonly a plumber *and* a
  // carpenter, and picking one would hide them from half the jobs they can do.
  // Order matters: the first picked becomes the headline trade on the listing.
  const [categories, setCategories] = useState<string[]>([]);
  // No session-scoped upload target here: the applicant is signed in as PUBLIC
  // and has no provider record yet, so both uploads go to the rate-limited
  // public route. Both stay private (the portrait is identity evidence, not a
  // listing photo) and come back as an asset id and claim token the application
  // submits; nobody but the applicant and the platform can open them.
  const photoUpload = useUploader({
    kind: "image",
    label: "Profile photo",
    target: "public",
  });
  const documentUpload = useUploader({
    kind: "document",
    label: "Supporting document",
    maxFiles: 8,
    target: "public",
  });
  const { clear: clearPhoto } = photoUpload;
  const { clear: clearDocuments } = documentUpload;
  // Approval re-issues an existing resident card as a provider card, so anyone
  // holding one is told before they apply rather than after it changes.
  const hasResidentCard = useHasResidentIdCard();
  const { confirm, confirmDialog } = useConfirm();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const value = (name: string) => {
      const field = form.get(name);

      return typeof field === "string" ? field.trim() : "";
    };

    if (categories.length === 0) {
      setError("Select at least one trade.");
      return;
    }

    if (
      hasResidentCard &&
      !(await confirm({
        actionLabel: "Yes, submit my application",
        description:
          "Your resident ID card will be automatically converted into a Service Provider card once your application is approved. You will no longer hold a resident card on this account.",
        title: "Apply as a service provider?",
      }))
    ) {
      return;
    }

    setIsSubmitting(true);
    setError("");

    try {
      const photo = photoUpload.files[0];

      await browserApi("/api/v1/public/service-providers/register", {
        body: JSON.stringify({
          area: value("area"),
          availability: value("availability") || undefined,
          categories,
          city: value("city") || "Kathmandu",
          description: value("description") || undefined,
          documents: [
            ...(photo?.assetId && photo.claimToken
              ? [
                  {
                    claimToken: photo.claimToken,
                    documentType: "PROFILE_PHOTO",
                    fileAssetId: photo.assetId,
                  },
                ]
              : []),
            ...documentUpload.files.flatMap((file) =>
              file.assetId && file.claimToken
                ? [
                    {
                      claimToken: file.claimToken,
                      documentType: "PROFILE_DOCUMENT",
                      fileAssetId: file.assetId,
                    },
                  ]
                : [],
            ),
          ].slice(0, 8),
          email: user.email ?? undefined,
          experience: value("experience") || undefined,
          fullName: value("fullName"),
          phone: value("phone"),
        }),
        method: "POST",
      });
      formElement.reset();
      setCategories([]);
      clearPhoto();
      clearDocuments();
      onSubmitted();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? submitError.message
          : "Could not submit registration.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="mx-auto max-w-[1080px] px-6 py-10">
      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-4 sm:px-10 sm:py-5">
          <span className="text-sm font-semibold text-foreground">
            Provider registration
          </span>
          <span className="text-sm font-semibold text-muted-foreground">Step 2 of 2</span>
        </div>

        {confirmDialog}

        <form
          className="flex flex-col gap-6 px-8 py-12 sm:px-14 lg:px-20"
          onSubmit={submit}
        >
          <div>
            <h1 className="font-heading text-[26px] font-extrabold text-foreground">
              Tell us about your trade
            </h1>
            <p className="mt-1.5 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
              <Mail className="size-4" />
              Signed in as
              <strong className="font-semibold text-foreground">
                {user.email ?? "your Google account"}
              </strong>
            </p>
          </div>

          {error ? (
            <p
              aria-live="polite"
              className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm font-medium text-destructive"
            >
              {error}
            </p>
          ) : null}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className={LABEL}>
              Full Name *
              <span className={FIELD_SHELL}>
                <UserRound className="size-4 text-muted-foreground" />
                <input
                  className={FIELD_INPUT}
                  defaultValue={user.name}
                  name="fullName"
                  placeholder="Enter your full name"
                  required
                />
              </span>
            </label>
            <label className={LABEL}>
              Phone *
              <span className={FIELD_SHELL}>
                <Phone className="size-4 text-muted-foreground" />
                <input
                  className={FIELD_INPUT}
                  defaultValue={user.phone ?? ""}
                  name="phone"
                  placeholder="+977"
                  required
                />
              </span>
            </label>
          </div>

          <fieldset>
            <legend className={LABEL}>Trades *</legend>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Pick every trade you work in — you&apos;ll be matched to jobs in all of
              them. The first one you pick is shown as your main trade.
            </p>
            <div className="mt-3 flex flex-wrap gap-2">
              {CATEGORIES.map((category) => {
                const index = categories.indexOf(category);
                const isSelected = index !== -1;

                return (
                  <button
                    aria-pressed={isSelected}
                    className={cn(
                      "flex items-center gap-1.5 rounded-full border px-4 py-2 text-[13px] font-semibold transition",
                      isSelected
                        ? "border-brand-teal bg-brand-teal text-white"
                        : "border-border bg-surface text-foreground hover:border-brand-teal",
                    )}
                    key={category}
                    onClick={() =>
                      setCategories((current) =>
                        current.includes(category)
                          ? current.filter((item) => item !== category)
                          : [...current, category],
                      )
                    }
                    type="button"
                  >
                    {isSelected ? <Check className="size-3.5" /> : null}
                    {categoryLabel(category)}
                    {index === 0 ? (
                      <span className="text-[11px] font-bold opacity-80">main</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          </fieldset>

          <div className="grid gap-4 sm:grid-cols-2">
            <label className={LABEL}>
              Area *
              <span className={FIELD_SHELL}>
                <MapPin className="size-4 text-muted-foreground" />
                <input
                  className={FIELD_INPUT}
                  name="area"
                  placeholder="Neighbourhood"
                  required
                />
              </span>
            </label>
            <label className={LABEL}>
              City *
              <span className={FIELD_SHELL}>
                <MapPin className="size-4 text-muted-foreground" />
                <input
                  className={FIELD_INPUT}
                  defaultValue="Kathmandu"
                  name="city"
                  required
                />
              </span>
            </label>
          </div>

          <label className={LABEL}>
            Availability{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
            <span className={FIELD_SHELL}>
              <CalendarDays className="size-4 text-muted-foreground" />
              <input
                className={FIELD_INPUT}
                name="availability"
                placeholder="Weekdays, emergency, on-call"
              />
            </span>
          </label>

          <label className={LABEL}>
            Experience{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
            <textarea
              className="mt-2 min-h-14 w-full rounded-xl border border-border bg-surface p-3 text-sm font-normal outline-none transition focus:border-brand-teal focus:ring-2 focus:ring-brand-teal/15"
              name="experience"
              placeholder="e.g. 5 years fixing residential plumbing"
            />
          </label>

          <label className={LABEL}>
            Description{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
            <textarea
              className="mt-2 min-h-24 w-full rounded-xl border border-border bg-surface p-3 text-sm font-normal outline-none transition focus:border-brand-teal focus:ring-2 focus:ring-brand-teal/15"
              name="description"
              placeholder="Describe your service coverage, tools, and response time."
            />
          </label>

          <div className={LABEL}>
            Photo &amp; Documents{" "}
            <span className="font-normal text-muted-foreground">(optional)</span>
            <div className="mt-2 grid gap-3 sm:grid-cols-[160px_1fr]">
              {/* The photo becomes the provider's portrait on their ID card and
                  in the directory, so they frame it themselves. */}
              <FileUploaderView
                cropImages
                label="Profile photo"
                size="sm"
                tone="brand"
                uploader={photoUpload}
              />
              <FileUploaderView
                label="Upload citizenship, licence, certificates (up to 8)"
                size="sm"
                tone="brand"
                uploader={documentUpload}
              />
            </div>
          </div>

          <button
            className="mt-2 w-full rounded-xl bg-brand-teal px-5 py-3.5 text-[15px] font-bold text-white transition hover:opacity-95 disabled:opacity-60"
            disabled={
              isSubmitting || photoUpload.isUploading || documentUpload.isUploading
            }
          >
            {isSubmitting ? "Submitting…" : "Submit Registration"}
          </button>

          <p className="text-center text-xs text-muted-foreground">
            You&apos;ll get an email once it&apos;s submitted, and can check status any
            time by signing back in.
          </p>
        </form>
      </div>
    </div>
  );
}

/** Step 3 — the application is in. There is no provider portal to send them to,
 *  so this is the end of the web journey by design. */
function SubmittedStep({ email }: { email: string | null }) {
  return (
    <div className="mx-auto max-w-[560px] px-6 py-16">
      <div className="rounded-2xl border border-border bg-card p-6 text-center shadow-sm sm:p-10">
        <div className="mx-auto grid size-14 place-items-center rounded-2xl bg-brand-teal-soft text-brand-teal">
          <CheckCircle2 className="size-7" />
        </div>
        <h1 className="mt-5 font-heading text-[22px] font-extrabold text-foreground">
          Registration submitted
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          We verify your details and documents in {PROVIDER_REVIEW_WINDOW}.
          {email ? (
            <>
              {" "}
              We&apos;ll email <strong className="text-foreground">{email}</strong> the
              moment a decision is made.
            </>
          ) : null}
        </p>
        <div className="mt-6 flex items-center justify-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3 text-left text-xs leading-relaxed text-muted-foreground">
          <BadgeCheck className="size-5 shrink-0 text-brand-teal" />
          Once approved, you&apos;ll receive sign-in details for the <SiteName /> Provider
          app, where hostels send you jobs. There&apos;s no provider dashboard on the
          website.
        </div>
        <Link
          className="mt-6 inline-block text-sm font-semibold text-brand-teal"
          href="/"
        >
          Back to <SiteName />
        </Link>
      </div>
    </div>
  );
}

function ServiceProviderRegistrationPageContent({
  stats,
}: ServiceProviderRegistrationPageProps) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [isSessionResolved, setIsSessionResolved] = useState(false);
  // `undefined` = not looked up yet, `null` = looked up, never applied.
  const [application, setApplication] = useState<OwnApplication | null | undefined>(
    undefined,
  );
  // Everyone starts on the landing hero, signed in or not — reaching the form is
  // always a deliberate click, never a side effect of having a session.
  const [step, setStep] = useState<"landing" | "form" | "submitted">("landing");

  useEffect(() => {
    let isMounted = true;

    void checkAuthWithRefresh()
      .then(async (response) => {
        const payload = (await response.json().catch(() => null)) as MeResponse | null;

        return response.ok && payload?.success ? (payload.data?.user ?? null) : null;
      })
      .catch(() => null)
      .then((sessionUser) => {
        if (isMounted) {
          setUser(sessionUser);
          setIsSessionResolved(true);
        }
      });

    return () => {
      isMounted = false;
    };
  }, []);

  // Has this account already applied? Only askable once there is a session.
  useEffect(() => {
    if (!user) {
      return;
    }

    let isMounted = true;

    void browserApi<{ provider: OwnApplication | null }>(
      "/api/v1/public/service-providers/me",
    )
      // A failed lookup must not strand someone who has never applied, so it
      // falls through to the normal CTA.
      .catch(() => ({ provider: null }))
      .then((data) => {
        if (isMounted) {
          setApplication(data.provider);
        }
      });

    return () => {
      isMounted = false;
    };
  }, [user]);

  const ownApplication = user ? (application ?? null) : null;
  const isApplicationLoading = Boolean(user) && application === undefined;
  // An account with a live application has nothing to submit — only a REJECTED
  // one may reach the form again. Guarded here as well as in the UI so a stale
  // `step` cannot survive the lookup resolving.
  const canOpenForm =
    Boolean(user) &&
    !isApplicationLoading &&
    (!ownApplication || !isApplicationOpen(ownApplication.status));

  return (
    <PublicShell active="providers">
      {!isSessionResolved ? (
        <div className="min-h-[calc(100vh-4rem)] animate-pulse bg-muted/40" />
      ) : step === "submitted" ? (
        <SubmittedStep email={user?.email ?? null} />
      ) : step === "form" && user && canOpenForm ? (
        <TradeDetailsStep onSubmitted={() => setStep("submitted")} user={user} />
      ) : (
        <LandingStep
          application={ownApplication}
          isApplicationLoading={isApplicationLoading}
          onContinue={() => setStep("form")}
          stats={stats}
          user={user}
        />
      )}
    </PublicShell>
  );
}

export type ServiceProviderRegistrationPageProps = {
  /**
   * The hero's live numbers, read on the server by `/service-providers` so they
   * are in the first paint. Absent when the read failed, and the hero then
   * shows only the facts it can state without a query.
   */
  stats?: ProviderStats;
};

export function ServiceProviderRegistrationPage(
  props: ServiceProviderRegistrationPageProps,
) {
  return (
    <Suspense fallback={null}>
      <ServiceProviderRegistrationPageContent {...props} />
    </Suspense>
  );
}
