"use client";

import {
  AlertTriangle,
  ArrowUpRight,
  BedDouble,
  ClipboardList,
  Eye,
  Mail,
  MapPin,
  Moon,
  Phone,
  Users,
  Utensils,
  WalletCards,
  Wrench,
} from "lucide-react";
import Link from "next/link";
import { memo } from "react";

import { HostelBranchesCard } from "@/app/_components/hostel-branches-card";
import { HostelFreeMonthCard } from "@/app/_components/hostel-free-month-card";
import { currency } from "@/app/_components/shared-ui";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useWorkspaceHref } from "@/hooks/use-workspace-href";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { Hostel, Message, ReportRecord } from "./core-portal-shared";
import {
  InitialsAvatar,
  MetricCard,
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

    const metrics = [
      {
        href: "/hostel-admin/residents",
        icon: Users,
        label: "Residents",
        tone: "cyan" as const,
        value: num(report?.residents).toLocaleString(),
      },
      {
        href: "/hostel-admin/rooms",
        icon: BedDouble,
        label: "Vacant Beds",
        tone: "green" as const,
        value: num(report?.vacantBeds).toLocaleString(),
      },
      {
        href: "/hostel-admin/payments",
        icon: WalletCards,
        label: "Dues This Month",
        tone: "amber" as const,
        value: currency(num(report?.monthlyDues)),
      },
      {
        href: "/hostel-admin/payments",
        icon: WalletCards,
        label: "Collected This Month",
        tone: "green" as const,
        value: currency(num(report?.paidAmount)),
      },
      {
        href: "/hostel-admin/complaints",
        icon: AlertTriangle,
        label: "Complaints",
        tone: "rose" as const,
        value: num(report?.complaints).toLocaleString(),
      },
      {
        href: "/hostel-admin/maintenance",
        icon: Wrench,
        label: "Maintenance",
        tone: "purple" as const,
        value: num(report?.maintenanceRequests).toLocaleString(),
      },
      {
        href: "/hostel-admin/food",
        icon: Utensils,
        label: "Food Feedback",
        tone: "blue" as const,
        value: num(report?.foodFeedback).toLocaleString(),
      },
      {
        href: "/hostel-admin/payments",
        icon: ClipboardList,
        label: "Pending Proofs",
        tone: "amber" as const,
        value: num(report?.pendingPaymentProofs).toLocaleString(),
      },
      {
        // How many people opened this hostel's public page — the top of the
        // funnel that ends in the Inquiries inbox. The card doubles as the way
        // to go look at the page those views landed on.
        external: Boolean(publicHref),
        href: publicHref || "/hostel-admin/inquiries",
        icon: Eye,
        label: "Listing Views",
        note: publicHref ? "Open public page" : undefined,
        tone: "cyan" as const,
        value: num(report?.totalPublicViews).toLocaleString(),
      },
    ];

    const quickLinks = [
      { href: "/hostel-admin/residents", label: "Manage Residents" },
      { href: "/hostel-admin/payments", label: "Review Payments" },
      { href: "/hostel-admin/inquiries", label: "New Inquiries" },
      { href: "/hostel-admin/night-status", label: "Night Status" },
      { href: "/hostel-admin/maintenance", label: "Maintenance Queue" },
      { href: "/hostel-admin/notices", label: "Publish Notice" },
    ];

    return (
      <div className="mx-auto max-w-[1448px] space-y-6">
        <PortalPageHeader
          breadcrumb={["Home", "Dashboard"]}
          description="Live hostel-scoped operations metrics from the database."
          title="Dashboard"
        />
        <Message value={message} />
        <HostelFreeMonthCard />
        <HostelBranchesCard />
        {loading ? <HostelAdminDashboardSkeleton /> : null}

        {/* Persistent by design (target §6.4): Tier 0.5 only catches a
            fabricated transaction id if somebody actually uploads the file, and
            nothing else in the product asks them to. */}
        {statementNudge?.due ? (
          <Link
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm transition hover:border-amber-500/60"
            href={workspaceHref("/hostel-admin/reconcile")}
          >
            <span className="flex items-center gap-2 font-semibold text-amber-900 dark:text-amber-300">
              <AlertTriangle aria-hidden="true" className="size-4" />
              {statementNudge.message}
            </span>
            <span className="font-semibold underline">Reconcile now</span>
          </Link>
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

              <div className="flex flex-col justify-center gap-3 p-5">
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
              </div>
            </div>
          </section>
        ) : null}

        {!loading ? (
          <>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {metrics.map((metric) => {
                const card = (
                  <MetricCard
                    icon={metric.icon}
                    label={metric.label}
                    note={metric.note}
                    tone={metric.tone}
                    value={metric.value}
                  />
                );

                // The public listing is outside the portal, so it opens in its own
                // tab and skips the workspace prefix.
                return metric.external ? (
                  <a
                    className="transition hover:-translate-y-0.5"
                    href={metric.href}
                    key={metric.label}
                    rel="noreferrer"
                    target="_blank"
                  >
                    {card}
                  </a>
                ) : (
                  <Link
                    className="transition hover:-translate-y-0.5"
                    href={workspaceHref(metric.href)}
                    key={metric.label}
                  >
                    {card}
                  </Link>
                );
              })}
            </div>

            <div className="grid gap-5 xl:grid-cols-[1.2fr_1fr]">
              <SectionCard title="Night Status Snapshot">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  {Object.keys(nightSummary).length === 0 ? (
                    <p className="col-span-full text-sm text-muted-foreground">
                      No night status records yet.
                    </p>
                  ) : (
                    Object.entries(nightSummary).map(([status, count]) => (
                      <div
                        className="rounded-lg border border-border bg-muted/20 p-4"
                        key={status}
                      >
                        <div className="flex items-center gap-2">
                          <Moon className="size-4 text-role-admin" />
                          <SoftBadge
                            tone={
                              status.toLowerCase().includes("inside")
                                ? "green"
                                : status.toLowerCase().includes("outside")
                                  ? "rose"
                                  : "amber"
                            }
                          >
                            {status.replaceAll("_", " ")}
                          </SoftBadge>
                        </div>
                        <p className="mt-3 text-2xl font-bold text-foreground">{count}</p>
                      </div>
                    ))
                  )}
                </div>
              </SectionCard>

              <SectionCard title="Quick Actions">
                <div className="grid gap-2 sm:grid-cols-2">
                  {quickLinks.map((item) => (
                    <Link
                      className="rounded-lg border border-border bg-muted/20 px-3 py-3 text-sm font-semibold text-foreground transition hover:border-role-admin/40 hover:bg-role-admin-soft/40"
                      href={workspaceHref(item.href)}
                      key={item.href}
                    >
                      {item.label}
                    </Link>
                  ))}
                </div>
              </SectionCard>
            </div>
          </>
        ) : null}
      </div>
    );
  },
);
