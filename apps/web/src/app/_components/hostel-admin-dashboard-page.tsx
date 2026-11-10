"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  BedDouble,
  ClipboardList,
  CalendarClock,
  ChevronRight,
  Eye,
  Mail,
  MapPin,
  Megaphone,
  MessageSquare,
  Moon,
  Phone,
  Users,
  Utensils,
  X,
  WalletCards,
  Wrench,
} from "@/components/icons";
import dynamic from "next/dynamic";
import Link from "next/link";
import { memo, useState } from "react";

import { formatHostelDate } from "@hostel/shared/calendar/bs";
import { HostelBranchesCard } from "@/app/_components/hostel-branches-card";
import { HostelFreeMonthCard } from "@/app/_components/hostel-free-month-card";
import { HostelKycBanner } from "@/app/_components/hostel-admin-kyc-page";
import { currency } from "@/app/_components/shared-ui";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { TrendPoint } from "@/components/monthly-trend-chart";
import { Skeleton } from "@/components/ui/skeleton";
import type { BillingHistory } from "@/lib/billing/billing.types";
import { useWorkspaceHref } from "@/hooks/use-workspace-href";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { Hostel, Message, ReportRecord } from "./core-portal-shared";
import {
  InitialsAvatar,
  MoneyFigure,
  PortalPageHeader,
  SectionCard,
  SoftBadge,
} from "./portal-dashboard-ui";

function num(value: unknown) {
  return typeof value === "number" ? value : 0;
}

/** "PENDING_REVIEW" -> "Pending review". */
function statusLabel(value: string) {
  const words = value.replaceAll("_", " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const hostelTypeLabels: Record<string, string> = {
  BOYS: "Boys hostel",
  CO_LIVING: "Co-living",
  GIRLS: "Girls hostel",
};

/** Mirrors `StatementNudge` in `finance/statements/statement-nudge.ts`. */
type StatementNudge = {
  cadenceDays: number;
  daysSinceUpload: number | null;
  due: boolean;
  message: string;
};

/** Mirrors the metric grid + snapshot/quick-actions layout below so the page
 * doesn't jump around once the real numbers arrive. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Where the hostel's plan stands, in one line: days left, the renewal bill once
 * it has been sent, or, after the plan has ended, what is owed and how long the
 * grace period has left. The grace clock is the platform's own suspension
 * record, never a guess.
 */
function PlanStatusStrip({
  billing,
  billingHref,
  suspension,
}: {
  billing: BillingHistory | null;
  billingHref: string;
  suspension: Hostel["suspension"];
}) {
  // A clock read once per mount, which is all a day-count needs.
  const [now] = useState(() => Date.now());
  const plan = billing?.plan;

  if (!plan || plan.lifetime) return null;

  const onTrial = !plan.planName && Boolean(plan.trialEndsAt);
  const days = plan.daysRemaining ?? (onTrial && plan.trialEndsAt ? Math.max(0, Math.ceil((Date.parse(plan.trialEndsAt) - now) / DAY_MS)) : null);

  // Quiet until it matters: the last week, the grace period, or a suspension.
  if (days === null || (days > 7 && !suspension)) return null;

  const owed = plan.amountDue > 0;
  const ended = days === 0;
  // Exact, like the banner above the page: rounding 2d 12h up to "3 days" said a different thing.
  const graceMs =
    suspension?.stage === "PRE_SUSPENSION"
      ? Math.max(0, Date.parse(suspension.graceEndsAt) - now)
      : null;
  const graceLeft =
    graceMs === null
      ? null
      : graceMs >= DAY_MS
        ? `${Math.floor(graceMs / DAY_MS)}d ${Math.floor((graceMs % DAY_MS) / 3_600_000)}h`
        : `${Math.floor(graceMs / 3_600_000)}h ${Math.floor((graceMs % 3_600_000) / 60_000)}m`;
  const noun = onTrial ? "trial" : "plan";
  let text: string;
  let tone: "bad" | "ok" | "warn";

  if (suspension?.stage === "SUSPENDED") {
    text = `Your ${noun} ended and access is suspended until the balance is paid.`;
    tone = "bad";
  } else if (ended && graceLeft !== null) {
    text = `Final notice: ${graceLeft} left before access stops. Pay now to keep your portal.`;
    tone = "bad";
  } else if (ended) {
    // Nothing locks: an ended trial or plan is on the free tier until it is renewed.
    text = `Your ${noun} has ended — you're on the Free plan${owed ? " until the renewal is paid" : ""}.`;
    tone = "warn";
  } else {
    text = days === 1 ? `Your ${noun} ends today.` : `Your ${noun} ends in ${days} days.`;
    tone = days <= 7 ? "warn" : "ok";
  }

  const toneClass = {
    bad: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
    ok: "border-border bg-muted/30 text-foreground",
    warn: "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  }[tone];

  return (
    <div className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-3 py-2 text-[13px] ${toneClass}`}>
      <CalendarClock className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 font-semibold">
        {text}
        {owed && !ended ? (
          <span className="ml-1 font-normal opacity-80">
            Renewal bill of {currency(plan.amountDue)} sent{plan.dueBy ? `, due ${formatHostelDate(plan.dueBy)}` : ""}.
          </span>
        ) : null}
      </span>
      {owed || ended ? (
        <Link
          className="inline-flex h-8 shrink-0 items-center rounded-lg bg-brand-teal px-3 text-xs font-bold text-white transition hover:brightness-110"
          href={billingHref}
        >
          {owed ? `Pay ${currency(plan.amountDue)}` : "Renew now"}
        </Link>
      ) : null}
    </div>
  );
}

/** The browser key one hostel's dismissal lives under: the workspace slug in the URL. */
function nudgeKey() {
  return `statement-nudge-dismissed:${window.location.pathname.split("/")[1] ?? ""}`;
}

/** The reconcile reminder, with a close button that only shows on hover and is remembered in the browser. */
function DismissibleNudge({ href, message }: { href: string; message: string }) {
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(nudgeKey()) === "1";
    } catch {
      return false;
    }
  });

  if (dismissed) return null;

  function dismiss() {
    setDismissed(true);

    try {
      localStorage.setItem(nudgeKey(), "1");
    } catch {
      // Private mode: it simply comes back next visit.
    }
  }

  return (
    <div className="group relative">
      <Link
        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm transition-[padding,border-color] duration-200 ease-out hover:border-amber-500/60 group-hover:pr-12 group-focus-within:pr-12 [@media(hover:none)]:pr-12"
        href={href}
      >
        <span className="flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-300">
          <AlertTriangle aria-hidden="true" className="size-4" />
          {message}
        </span>
        <span className="font-semibold underline">Reconcile now</span>
      </Link>
      <button
        aria-label="Dismiss reminder"
        className="absolute right-3 top-1/2 flex size-7 -translate-y-1/2 translate-x-1 items-center justify-center rounded-full text-amber-900 opacity-0 transition duration-200 ease-out hover:bg-amber-500/20 focus-visible:translate-x-0 focus-visible:opacity-100 group-hover:translate-x-0 group-hover:opacity-100 dark:text-amber-300 [@media(hover:none)]:opacity-100"
        onClick={dismiss}
        type="button"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}

type StatTileProps = {
  icon: typeof Users;
  label: string;
  meta: string;
  tone?: "bad" | "brand" | "warn";
  value: string;
};

const TILE_TONES = {
  bad: "bg-rose-500/10 text-rose-600",
  brand: "bg-role-team-soft text-role-team",
  warn: "bg-amber-500/10 text-amber-600",
};

/** A narrow, tall stat: icon, the number, what it is, and one line of context. */
function StatTile({ icon: Icon, label, meta, tone = "brand", value }: StatTileProps) {
  return (
    <div className="flex h-full min-h-[148px] flex-col gap-3 rounded-2xl border border-border bg-card p-4">
      <span className={`flex size-9 items-center justify-center rounded-full ${TILE_TONES[tone]}`}>
        <Icon className="size-[18px]" />
      </span>
      <div className="min-w-0">
        <p className="truncate text-[22px] font-bold leading-tight tabular-nums text-foreground"><MoneyFigure value={value} /></p>
        <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{label}</p>
      </div>
      <p className="mt-auto text-[12px] leading-snug text-muted-foreground">{meta}</p>
    </div>
  );
}

const MonthlyTrendChart = dynamic(() => import("@/components/monthly-trend-chart"), {
  loading: () => <Skeleton className="h-[300px] w-full rounded-xl" />,
  ssr: false,
});

/** Six BS months of money raised, money collected and listing views, as lines. */
function MonthlyTrend({ href, points }: { href: string; points: TrendPoint[] }) {
  if (points.length === 0) return null;

  return (
    <SectionCard
      actions={
        <Link
          className="inline-flex items-center gap-1 text-[12.5px] font-semibold text-role-admin hover:underline"
          href={href}
        >
          See full analytics
          <ArrowUpRight className="size-3.5" />
        </Link>
      }
      title="Last 6 months"
    >
      <MonthlyTrendChart points={points} />
    </SectionCard>
  );
}

function HostelAdminDashboardSkeleton() {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }).map((_, index) => (
          <Card className="shadow-sm ring-border/60" key={index} size="sm">
            <CardContent>
              <div className="flex items-start gap-2.5">
                <Skeleton className="size-9 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-2">
                  <Skeleton className="h-3 w-20" />
                  <Skeleton className="h-5 w-14" />
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <div className="grid gap-5 xl:grid-cols-[1.2fr_1fr]">
        <Card className="shadow-sm ring-border/60" size="sm">
          <CardHeader className="border-b border-border/60 pb-3">
            <Skeleton className="h-3.5 w-40" />
          </CardHeader>
          <CardContent className="pt-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {Array.from({ length: 3 }).map((_, index) => (
                <div className="rounded-lg border border-border bg-muted/20 p-4" key={index}>
                  <Skeleton className="h-5 w-20 rounded-full" />
                  <Skeleton className="mt-3 h-6 w-10" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="shadow-sm ring-border/60" size="sm">
          <CardHeader className="border-b border-border/60 pb-3">
            <Skeleton className="h-3.5 w-28" />
          </CardHeader>
          <CardContent className="pt-3">
            <div className="grid gap-2 sm:grid-cols-2">
              {Array.from({ length: 6 }).map((_, index) => (
                <Skeleton className="h-11 rounded-lg" key={index} />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

export const HostelAdminDashboardPageContent = memo(
  function HostelAdminDashboardPageContent() {
    const workspaceHref = useWorkspaceHref();
    const reportResource = usePortalResource<{
      report: ReportRecord;
      statementNudge: StatementNudge | null;
    }>(
      hostelAdminEndpoints.dashboardReport,
      { errorMessage: "Could not load dashboard." },
    );

    // Same cache entry the Profile / Rooms screens already fill — this feeds
    // the hostel card below and the public-page link.
    const profileResource = usePortalResource<{ hostel: Hostel }>(
      hostelAdminEndpoints.profile,
      { errorMessage: "Could not load hostel profile." },
    );

    const billingResource = usePortalResource<{ history: BillingHistory }>("/api/v1/hostel-admin/billing");

    const report = reportResource.data?.report ?? null;
    const statementNudge = reportResource.data?.statementNudge ?? null;
    const message = reportResource.message;
    const loading = reportResource.state === "loading";

    const hostel = profileResource.data?.hostel ?? null;
    // The public page only serves published + verified hostels, so previewing
    // anything else would just 404 the admin.
    const publicHref =
      hostel &&
      hostel.status === "PUBLISHED" &&
      hostel.verificationStatus === "VERIFIED" &&
      hostel.slug
        ? `/hostels/${hostel.slug}`
        : "";

    // The building, not a bedroom — the same cover the resident dashboard and
    // the public listing lead with. Any photo beats none.
    const photos = hostel?.photos ?? [];
    const coverPhotoUrl =
      (photos.find((photo) => photo.kind === "EXTERIOR" && photo.url) ?? photos[0])?.url ?? "";
    const addressLine =
      [hostel?.location?.address, hostel?.location?.area, hostel?.location?.city]
        .filter(Boolean)
        .join(", ") || "Location not set";

    const nightSummary =
      report?.nightStatusSummary && typeof report.nightStatusSummary === "object"
        ? (report.nightStatusSummary as Record<string, number>)
        : {};

    const residents = num(report?.residents);
    const vacant = num(report?.vacantBeds);
    const beds = residents + vacant;
    const dues = num(report?.monthlyDues);
    const paid = num(report?.paidAmount);
    const toCollect = Math.max(dues - paid, 0);
    const proofs = num(report?.pendingPaymentProofs);
    const complaints = num(report?.complaints);
    const maintenance = num(report?.maintenanceRequests);
    const trend = (report?.trend ?? []) as TrendPoint[];

    const metrics: Array<StatTileProps & { external?: boolean; href: string }> = [
      { href: "/hostel-admin/residents", icon: Users, label: "Residents", meta: "Living in the hostel", value: residents.toLocaleString() },
      {
        href: "/hostel-admin/rooms",
        icon: BedDouble,
        label: "Occupancy",
        meta: beds > 0 ? `${residents} of ${beds} beds filled` : "No beds set up",
        value: beds > 0 ? `${Math.round((residents / beds) * 100)}%` : "—",
      },
      { href: "/hostel-admin/rooms", icon: BedDouble, label: "Vacant beds", meta: "Ready for new residents", value: vacant.toLocaleString() },
      {
        href: "/hostel-admin/payments",
        icon: WalletCards,
        label: "Dues this month",
        meta: toCollect > 0 ? `${currency(toCollect)} still to collect` : "Everything collected",
        tone: toCollect > 0 ? "warn" : "brand",
        value: currency(dues),
      },
      {
        href: "/hostel-admin/payments",
        icon: WalletCards,
        label: "Collected",
        meta: dues > 0 ? `${Math.min(100, Math.round((paid / dues) * 100))}% of the dues` : "This month",
        value: currency(paid),
      },
      {
        href: "/hostel-admin/payments",
        icon: ClipboardList,
        label: "Pending proofs",
        meta: proofs > 0 ? "Waiting for your review" : "All reviewed",
        tone: proofs > 0 ? "warn" : "brand",
        value: proofs.toLocaleString(),
      },
      {
        href: "/hostel-admin/complaints",
        icon: AlertTriangle,
        label: "Complaints",
        meta: complaints > 0 ? "Need a reply" : "All clear",
        tone: complaints > 0 ? "bad" : "brand",
        value: complaints.toLocaleString(),
      },
      {
        href: "/hostel-admin/maintenance",
        icon: Wrench,
        label: "Maintenance",
        meta: maintenance > 0 ? "In the queue" : "Nothing pending",
        tone: maintenance > 0 ? "warn" : "brand",
        value: maintenance.toLocaleString(),
      },
      { href: "/hostel-admin/food", icon: Utensils, label: "Food feedback", meta: "From residents", value: num(report?.foodFeedback).toLocaleString() },
      {
        // How many people opened this hostel's public page, the top of the
        // funnel that ends in the Inquiries inbox. The tile doubles as the way
        // to go look at the page those views landed on.
        external: Boolean(publicHref),
        href: publicHref || "/hostel-admin/inquiries",
        icon: Eye,
        label: "Listing views",
        meta: publicHref ? "Open public page" : "On your public page",
        value: num(report?.totalPublicViews).toLocaleString(),
      },
    ];

    const quickLinks = [
      { href: "/hostel-admin/residents", icon: Users, label: "Manage residents", meta: "Add, edit, move out" },
      { href: "/hostel-admin/payments", icon: WalletCards, label: "Review payments", meta: "Dues and proofs" },
      { href: "/hostel-admin/inquiries", icon: MessageSquare, label: "New inquiries", meta: "Reply to visitors" },
      { href: "/hostel-admin/night-status", icon: Moon, label: "Night status", meta: "Who is in tonight" },
      { href: "/hostel-admin/maintenance", icon: Wrench, label: "Maintenance queue", meta: "Fix requests" },
      { href: "/hostel-admin/notices", icon: Megaphone, label: "Publish notice", meta: "Tell every resident" },
    ];

    return (
      <div className="mx-auto max-w-[1448px] space-y-6">
        <PortalPageHeader
          breadcrumb={["Home", "Dashboard"]}
          description="Live hostel-scoped operations metrics from the database."
          title="Dashboard"
        />
        <Message value={message} />
        <HostelKycBanner />
        <HostelFreeMonthCard />
        {loading ? <HostelAdminDashboardSkeleton /> : null}

        {/* Persistent by design (target §6.4): Tier 0.5 only catches a
            fabricated transaction id if somebody actually uploads the file, and
            nothing else in the product asks them to. */}
        {statementNudge?.due ? (
          <DismissibleNudge href={workspaceHref("/hostel-admin/reconcile")} message={statementNudge.message} />
        ) : null}

        {/* The hostel leads the page: every metric below is *about* this
            building, and the exterior photo is what makes an owner recognise
            which of their hostels this workspace is. */}
        {profileResource.state === "loading" ? (
          <Skeleton className="h-44 rounded-2xl md:h-52" />
        ) : null}
        {hostel ? (
          <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
            <div className="grid md:grid-cols-[minmax(0,320px)_1fr]">
              <div className="relative h-44 md:h-full md:min-h-[208px]">
                {coverPhotoUrl ? (
                  <div
                    aria-label={`${hostel.name} exterior`}
                    className="size-full bg-cover bg-center"
                    role="img"
                    style={{ backgroundImage: `url("${coverPhotoUrl}")` }}
                  />
                ) : (
                  <div className="flex size-full items-center justify-center bg-role-admin-soft">
                    <InitialsAvatar name={hostel.name} size="lg" tone="admin" />
                  </div>
                )}
              </div>

              <div className="flex flex-col justify-center gap-6 p-5 md:px-7 md:py-6">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-xl font-bold text-foreground">{hostel.name}</h2>
                    {/* Unlike the resident's copy of this card, the badges here
                        report the real state — the owner is the one who has to
                        act on a listing that is still unverified or a draft. */}
                    <SoftBadge tone={hostel.verificationStatus === "VERIFIED" ? "green" : "amber"}>
                      {statusLabel(hostel.verificationStatus)}
                    </SoftBadge>
                    {hostel.status === "PUBLISHED" ? null : (
                      <SoftBadge tone="slate">{statusLabel(hostel.status)}</SoftBadge>
                    )}
                  </div>
                  <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                    <MapPin className="size-3.5 shrink-0" />
                    {addressLine}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/20 px-2.5 py-1.5 font-semibold text-foreground">
                    <BedDouble className="size-3.5 text-role-admin" />
                    {hostelTypeLabels[hostel.hostelType] ?? statusLabel(hostel.hostelType)}
                  </span>
                  {hostel.contact?.phone ? (
                    <a
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 font-semibold text-foreground transition hover:bg-muted"
                      href={`tel:${hostel.contact.phone}`}
                    >
                      <Phone className="size-3.5 text-role-admin" />
                      {hostel.contact.phone}
                    </a>
                  ) : null}
                  {hostel.hostelCode ? (
                    <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/20 px-2.5 py-1.5 text-muted-foreground">
                      Hostel ID
                      <strong className="select-all font-mono text-foreground">{hostel.hostelCode}</strong>
                    </span>
                  ) : null}
                  {hostel.contact?.email ? (
                    <a
                      className="inline-flex min-w-0 items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 font-semibold text-foreground transition hover:bg-muted"
                      href={`mailto:${hostel.contact.email}`}
                    >
                      <Mail className="size-3.5 shrink-0 text-role-admin" />
                      <span className="truncate">{hostel.contact.email}</span>
                    </a>
                  ) : null}
                  {publicHref ? (
                    <a
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 font-semibold text-role-admin transition hover:bg-role-admin-soft/40"
                      href={publicHref}
                      rel="noreferrer"
                      target="_blank"
                    >
                      View hostel page
                      <ArrowUpRight className="size-3.5" />
                    </a>
                  ) : (
                    // Nothing to preview until the listing is published, so
                    // point at the screen that gets it there instead.
                    <Link
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 font-semibold text-role-admin transition hover:bg-role-admin-soft/40"
                      href={workspaceHref("/hostel-admin/profile")}
                    >
                      Manage listing
                      <ArrowUpRight className="size-3.5" />
                    </Link>
                  )}
                </div>

                <PlanStatusStrip
                  billing={billingResource.data?.history ?? null}
                  billingHref={workspaceHref("/hostel-admin/billing")}
                  suspension={hostel.suspension}
                />
              </div>
            </div>
          </section>
        ) : null}

        {!loading ? (
          <>
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
              {metrics.map(({ external, href, ...tile }) =>
                // The public listing is outside the portal, so it opens in its own
                // tab and skips the workspace prefix.
                external ? (
                  <a className="transition hover:-translate-y-0.5" href={href} key={tile.label} rel="noreferrer" target="_blank">
                    <StatTile {...tile} />
                  </a>
                ) : (
                  <Link className="transition hover:-translate-y-0.5" href={workspaceHref(href)} key={tile.label}>
                    <StatTile {...tile} />
                  </Link>
                ),
              )}
            </div>

            <MonthlyTrend href={workspaceHref("/hostel-admin/reports")} points={trend} />

            <SectionCard title="Tonight and quick actions">
              <div className="space-y-5">
                <div>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Night status</p>
                  {Object.keys(nightSummary).length === 0 ? (
                    <p className="text-sm text-muted-foreground">No night status records yet.</p>
                  ) : (
                    <div className="grid grid-cols-3 divide-x divide-border overflow-hidden rounded-xl border border-border bg-muted/20">
                      {Object.entries(nightSummary).map(([status, count]) => {
                        const key = status.toLowerCase();
                        const dot = key.includes("inside") ? "bg-emerald-500" : key.includes("outside") ? "bg-rose-500" : "bg-amber-500";

                        return (
                          <Link className="px-4 py-3 transition hover:bg-muted/50" href={workspaceHref("/hostel-admin/night-status")} key={status}>
                            <p className="flex items-center gap-2 text-[12px] font-semibold text-muted-foreground">
                              <span className={`size-2 rounded-full ${dot}`} />
                              {statusLabel(status)}
                            </p>
                            <p className="mt-1 text-2xl font-bold tabular-nums text-foreground">{count}</p>
                          </Link>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div>
                  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">Quick actions</p>
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {quickLinks.map((item) => (
                      <Link
                        className="group flex items-center gap-3 rounded-xl border border-border px-3 py-2.5 transition hover:border-role-admin/40 hover:bg-role-admin-soft/40"
                        href={workspaceHref(item.href)}
                        key={item.href}
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-role-team-soft text-role-team">
                          <item.icon className="size-[18px]" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13.5px] font-semibold text-foreground">{item.label}</span>
                          <span className="block truncate text-[11.5px] text-muted-foreground">{item.meta}</span>
                        </span>
                        <ChevronRight className="size-4 shrink-0 text-muted-foreground transition group-hover:translate-x-0.5" />
                      </Link>
                    ))}
                  </div>
                </div>
              </div>
            </SectionCard>
          </>
        ) : null}

        <HostelBranchesCard />
      </div>
    );
  },
);
