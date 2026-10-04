"use client";

import {
  Building2,
  CalendarRange,
  MessageSquare,
  Clock3,
  ScrollText,
  ShieldCheck,
  Users,
  WalletCards,
  Wrench,
} from "lucide-react";
import { memo, useState } from "react";

import { LoadingRows } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { combineResources, usePortalResource } from "@/lib/portal-query";
import { DemoDataBadge, Hostel, Message } from "./core-portal-shared";
import {
  AreaSparkline,
  EmptyInline,
  InitialsAvatar,
  ListPager,
  MetricCard,
  PortalPageHeader,
  SectionCard,
  SoftBadge,
  statusToneFromLabel,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ViewAllLink,
  DataTable,
} from "./portal-dashboard-ui";

type MetricTrend = {
  changePercent: number | null;
  current: number;
  previous: number;
};

type PlatformDashboardReport = {
  activeResidents: number;
  complaints: number;
  inquiries: number;
  openListingFlags: number;
  outstandingPayments: number;
  pendingApprovals: number;
  platformPayments: number;
  reviews: number;
  series: {
    bucketDays: number;
    hostels: number[];
    inquiries: number[];
    labels: string[];
    revenue: number[];
  };
  serviceProviders: number;
  totalHostels: number;
  trends: Record<string, MetricTrend | undefined>;
  windowDays: number;
};

type PlatformPayment = {
  paidAt: string | null;
  provider: string;
  hostelName: string;
  id: string;
  paidAmount: number;
  status: string;
};

type PlatformPaymentsResponse = {
  pagination: { total: number };
  recent: PlatformPayment[];
};

type AuditLog = {
  action: string;
  actorLabel: string;
  createdAt: string | null;
  entityType: string;
  hostelLabel: string | null;
  id: string;
};

const RECENT_ROW_LIMIT = 5;
const AUDIT_ROW_LIMIT = 5;

function npr(value: number) {
  return `NPR ${Math.round(value).toLocaleString()}`;
}

function compactNpr(value: number) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return Math.round(value).toLocaleString();
}

/** Signed, human-readable movement over the report's comparison window. */
function trendLabel(trend: MetricTrend | undefined, windowDays: number) {
  if (!trend) return undefined;

  if (trend.changePercent === null) {
    if (trend.current === 0) return `No change in ${windowDays} days`;
    return `+${trend.current.toLocaleString()} in ${windowDays} days`;
  }

  const sign = trend.changePercent >= 0 ? "" : "-";
  return `${sign}${Math.abs(trend.changePercent)}% vs previous ${windowDays} days`;
}

function trendIsDown(trend: MetricTrend | undefined) {
  return Boolean(trend && trend.changePercent !== null && trend.changePercent < 0);
}

function shortDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function relativeTime(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";

  const minutes = Math.round((Date.now() - date.getTime()) / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function humanizeAction(action: string) {
  return action
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/^\w/, (character) => character.toUpperCase());
}

function windowRangeLabel(windowDays: number) {
  const end = new Date();
  const start = new Date(end.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const format = (date: Date) =>
    date.toLocaleDateString(undefined, { day: "numeric", month: "short" });

  return `${format(start)} – ${format(end)}, ${end.getFullYear()}`;
}

export const PlatformDashboardPageContent = memo(function PlatformDashboardPageContent() {
  const [hostelPage, setHostelPage] = useState(1);
  const [paymentPage, setPaymentPage] = useState(1);
  const reportResource = usePortalResource<{ report: PlatformDashboardReport }>(
    platformEndpoints.dashboardReport,
    { errorMessage: "Could not load dashboard." },
  );
  const hostelsResource = usePortalResource<{ hostels: Hostel[]; pagination: { total: number } }>(
    `/api/v1/platform/hostels?page=${hostelPage}&pageSize=${RECENT_ROW_LIMIT}`,
    { errorMessage: "Could not load dashboard." },
  );
  const paymentsResource = usePortalResource<PlatformPaymentsResponse>(
    `${platformEndpoints.payments}?view=recent&page=${paymentPage}&pageSize=${RECENT_ROW_LIMIT}`,
    { errorMessage: "Could not load payments." },
  );
  const auditResource = usePortalResource<{ logs: AuditLog[] }>(
    `${platformEndpoints.auditLogs}?limit=${AUDIT_ROW_LIMIT}`,
    { errorMessage: "Could not load audit activity." },
  );

  const { message, state } = combineResources(
    reportResource,
    hostelsResource,
    paymentsResource,
    auditResource,
  );
  const report = reportResource.data?.report ?? null;
  const allHostels = hostelsResource.data?.hostels ?? [];
  const totalHostelCount = hostelsResource.data?.pagination.total ?? 0;
  const hostels = allHostels.slice(0, RECENT_ROW_LIMIT);
  const allPayments = paymentsResource.data?.recent ?? [];
  const payments = allPayments.slice(0, RECENT_ROW_LIMIT);
  const auditLogs = (auditResource.data?.logs ?? []).slice(0, AUDIT_ROW_LIMIT);

  const windowDays = report?.windowDays ?? 30;
  const trends = report?.trends ?? {};
  const series = report?.series;
  const chartLabels = (series?.labels ?? []).map((label) => shortDate(label));

  const metrics = [
    {
      icon: Building2,
      label: "Total Hostels",
      tone: "blue" as const,
      trend: trendLabel(trends.totalHostels, windowDays),
      trendDown: trendIsDown(trends.totalHostels),
      value: (report?.totalHostels ?? 0).toLocaleString(),
    },
    {
      icon: Clock3,
      label: "Pending Approvals",
      tone: "amber" as const,
      trend: trendLabel(trends.pendingApprovals, windowDays),
      trendDown: trendIsDown(trends.pendingApprovals),
      value: (report?.pendingApprovals ?? 0).toLocaleString(),
    },
    {
      icon: Users,
      label: "Active Residents",
      tone: "green" as const,
      trend: trendLabel(trends.activeResidents, windowDays),
      trendDown: trendIsDown(trends.activeResidents),
      value: (report?.activeResidents ?? 0).toLocaleString(),
    },
    {
      icon: MessageSquare,
      label: "Inquiries",
      tone: "purple" as const,
      trend: trendLabel(trends.inquiries, windowDays),
      trendDown: trendIsDown(trends.inquiries),
      value: (report?.inquiries ?? 0).toLocaleString(),
    },
    {
      icon: Wrench,
      label: "Service Providers",
      tone: "blue" as const,
      trend: trendLabel(trends.serviceProviders, windowDays),
      trendDown: trendIsDown(trends.serviceProviders),
      value: (report?.serviceProviders ?? 0).toLocaleString(),
    },
    {
      icon: ShieldCheck,
      label: "Complaints & Flags",
      tone: "rose" as const,
      trend: trendLabel(trends.complaints, windowDays),
      trendDown: trendIsDown(trends.complaints),
      value: (
        (report?.complaints ?? 0) + (report?.openListingFlags ?? 0)
      ).toLocaleString(),
    },
    {
      icon: WalletCards,
      label: "Collected Payments",
      note: report ? `${npr(report.outstandingPayments)} outstanding` : undefined,
      tone: "green" as const,
      trend: trendLabel(trends.platformPayments, windowDays),
      trendDown: trendIsDown(trends.platformPayments),
      value: npr(report?.platformPayments ?? 0),
    },
  ];

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PortalPageHeader
        actions={
          <Button
            className="h-9 gap-2 rounded-lg border-border bg-card px-3 text-xs font-semibold text-muted-foreground shadow-sm"
            type="button"
            variant="outline"
          >
            <CalendarRange className="size-3.5 text-role-platform" />
            {windowRangeLabel(windowDays)}
          </Button>
        }
        breadcrumb={["Home", "Dashboard"]}
        title="Dashboard"
      />

      <Message value={message} />
      {state === "loading" ? <LoadingRows /> : null}

      {state !== "loading" ? (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {metrics.slice(0, 4).map((metric) => (
              <MetricCard key={metric.label} {...metric} />
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {metrics.slice(4).map((metric) => (
              <MetricCard key={metric.label} {...metric} />
            ))}
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <SectionCard
              actions={<ViewAllLink href="/platform/hostels" tone="platform" />}
              title="Recent Hostel Applications"
            >
              {hostels.length === 0 ? (
                <EmptyInline label="No hostel applications yet." />
              ) : (
                <>
                  <DataTable className="min-w-[560px]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Hostel Name
                        </TableHead>
                        <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Location
                        </TableHead>
                        <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Owner
                        </TableHead>
                        <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Status
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {hostels.map((hostel) => (
                        <TableRow key={hostel.id}>
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <InitialsAvatar
                                name={hostel.name}
                                size="sm"
                                tone="platform"
                              />
                              <div className="min-w-0">
                                <p className="truncate font-semibold text-foreground">
                                  {hostel.name}
                                </p>
                                {hostel.isDemoData ? (
                                  <DemoDataBadge label={hostel.demoDataLabel} />
                                ) : null}
                              </div>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {hostel.location.area}
                            {hostel.location.city ? `, ${hostel.location.city}` : ""}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {hostel.owner?.name || "—"}
                          </TableCell>
                          <TableCell>
                            <SoftBadge tone={statusToneFromLabel(hostel.status)}>
                              {hostel.status.replaceAll("_", " ")}
                            </SoftBadge>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </DataTable>
                  <ListPager page={hostelPage} onPageChange={setHostelPage} pageSize={RECENT_ROW_LIMIT} total={totalHostelCount} />
                </>
              )}
            </SectionCard>

            <SectionCard
              actions={<ViewAllLink href="/platform/payments" tone="platform" />}
              title="Recent Payments"
            >
              {payments.length === 0 ? (
                <EmptyInline label="No payments recorded yet." />
              ) : (
                <>
                  <DataTable className="min-w-[560px]">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Hostel / Organization
                        </TableHead>
                        <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Method
                        </TableHead>
                        <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Amount
                        </TableHead>
                        <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Status
                        </TableHead>
                        <TableHead className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                          Paid Date
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {payments.map((payment) => (
                        <TableRow key={payment.id}>
                          <TableCell>
                            <div className="flex items-center gap-3">
                              <InitialsAvatar
                                name={payment.hostelName}
                                size="sm"
                                tone="platform"
                              />
                              <p className="truncate font-semibold text-foreground">
                                {payment.hostelName}
                              </p>
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {payment.provider.replaceAll("_", " ")}
                          </TableCell>
                          <TableCell className="font-semibold text-foreground">
                            {npr(payment.paidAmount)}
                          </TableCell>
                          <TableCell>
                            <SoftBadge tone={statusToneFromLabel(payment.status)}>
                              {payment.status.replaceAll("_", " ")}
                            </SoftBadge>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {shortDate(payment.paidAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </DataTable>
                  <ListPager page={paymentPage} onPageChange={setPaymentPage} pageSize={RECENT_ROW_LIMIT} total={paymentsResource.data?.pagination.total ?? 0} />
                </>
              )}
            </SectionCard>
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.55fr_1fr]">
            <SectionCard
              actions={
                <span className="text-[11px] font-semibold text-muted-foreground">
                  Last {(series?.bucketDays ?? 7) * (series?.labels.length ?? 5)} days
                </span>
              }
              title="Analytics Overview"
            >
              <div className="grid gap-4 md:grid-cols-3">
                {[
                  {
                    label: "Hostel Registrations",
                    stroke: "#2563eb",
                    trend: trends.totalHostels,
                    value: (report?.totalHostels ?? 0).toLocaleString(),
                    values: series?.hostels ?? [],
                  },
                  {
                    label: "Inquiries",
                    stroke: "#10b981",
                    trend: trends.inquiries,
                    value: (report?.inquiries ?? 0).toLocaleString(),
                    values: series?.inquiries ?? [],
                  },
                  {
                    label: "Revenue (NPR)",
                    stroke: "#8b5cf6",
                    trend: trends.platformPayments,
                    value: compactNpr(report?.platformPayments ?? 0),
                    values: series?.revenue ?? [],
                  },
                ].map((chart) => {
                  const change = chart.trend?.changePercent ?? null;

                  return (
                    <div
                      className="rounded-xl border border-border/70 bg-muted/15 p-4"
                      key={chart.label}
                    >
                      <p className="text-xs font-medium text-muted-foreground">
                        {chart.label}
                      </p>
                      <p className="mt-1 flex items-baseline gap-1.5">
                        <span className="text-xl font-bold text-foreground">
                          {chart.value}
                        </span>
                        {change === null ? null : (
                          <span
                            className={`text-[11px] font-semibold ${
                              change < 0 ? "text-rose-600" : "text-emerald-600"
                            }`}
                          >
                            {change < 0 ? "↓" : "↑"} {Math.abs(change)}%
                          </span>
                        )}
                      </p>
                      <div className="mt-3">
                        <AreaSparkline
                          labels={chartLabels}
                          stroke={chart.stroke}
                          values={
                            chart.values.length > 0 ? chart.values : [0, 0, 0, 0, 0]
                          }
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </SectionCard>

            <SectionCard
              actions={
                <ViewAllLink
                  href="/platform/audit-logs"
                  label="View all"
                  tone="platform"
                />
              }
              title="Recent Audit Activity"
            >
              {auditLogs.length === 0 ? (
                <EmptyInline label="No audit activity recorded yet." />
              ) : (
                <div className="space-y-2.5">
                  {auditLogs.map((log) => (
                    <div
                      className="flex items-start gap-3 rounded-xl border border-border/60 bg-muted/10 px-3 py-2.5"
                      key={log.id}
                    >
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-role-platform-soft text-role-platform">
                        <ScrollText className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="text-sm font-semibold leading-snug text-foreground">
                          {humanizeAction(log.action)}
                          {log.hostelLabel ? ` — ${log.hostelLabel}` : ""}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          by {log.actorLabel} · {log.entityType.toLowerCase()}
                        </p>
                      </div>
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {relativeTime(log.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </SectionCard>
          </div>
        </>
      ) : null}
    </div>
  );
});
