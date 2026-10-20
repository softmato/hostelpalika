"use client";

import { formatHostelDate } from "@hostel/shared/calendar/bs";

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
} from "@/components/icons";
import { memo, useState } from "react";

import { LoadingRows, Panel } from "@/app/_components/shared-ui";
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
  SoftBadge,
  statusToneFromLabel,
  ViewAllLink,
} from "./portal-dashboard-ui";
import { ShareBar } from "./platform-page-ui";
import { WalletMark } from "@/components/wallet-mark";

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
    : formatHostelDate(date);
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
    formatHostelDate(date);

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
      label: "Hostels",
      trend: trendLabel(trends.totalHostels, windowDays),
      trendDown: trendIsDown(trends.totalHostels),
      value: (report?.totalHostels ?? 0).toLocaleString(),
    },
    {
      icon: Clock3,
      label: "Waiting approval",
      tone: "amber" as const,
      trend: trendLabel(trends.pendingApprovals, windowDays),
      trendDown: trendIsDown(trends.pendingApprovals),
      value: (report?.pendingApprovals ?? 0).toLocaleString(),
    },
    {
      icon: Users,
      label: "Active residents",
      trend: trendLabel(trends.activeResidents, windowDays),
      trendDown: trendIsDown(trends.activeResidents),
      value: (report?.activeResidents ?? 0).toLocaleString(),
    },
    {
      icon: WalletCards,
      label: "Collected",
      trend: trendLabel(trends.platformPayments, windowDays),
      trendDown: trendIsDown(trends.platformPayments),
      value: npr(report?.platformPayments ?? 0),
    },
    {
      icon: MessageSquare,
      label: "Inquiries",
      trend: trendLabel(trends.inquiries, windowDays),
      trendDown: trendIsDown(trends.inquiries),
      value: (report?.inquiries ?? 0).toLocaleString(),
    },
    {
      icon: Wrench,
      label: "Service providers",
      trend: trendLabel(trends.serviceProviders, windowDays),
      trendDown: trendIsDown(trends.serviceProviders),
      value: (report?.serviceProviders ?? 0).toLocaleString(),
    },
    {
      icon: ShieldCheck,
      label: "Complaints & flags",
      tone: "rose" as const,
      trend: trendLabel(trends.complaints, windowDays),
      trendDown: trendIsDown(trends.complaints),
      value: ((report?.complaints ?? 0) + (report?.openListingFlags ?? 0)).toLocaleString(),
    },
  ];

  const collected = Math.round(report?.platformPayments ?? 0);
  const outstanding = Math.round(report?.outstandingPayments ?? 0);

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PortalPageHeader
        actions={
          <span className="inline-flex h-9 items-center gap-2 rounded-xl border border-border px-3 text-[12.5px] font-semibold text-muted-foreground">
            <CalendarRange className="size-3.5 text-role-team" />
            {windowRangeLabel(windowDays)}
          </span>
        }
        description="Hostels, money and flags across the platform."
        title="Dashboard"
      />

      <Message value={message} />
      {state === "loading" ? <LoadingRows /> : null}

      {state !== "loading" ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {metrics.map((metric) => (
              <MetricCard key={metric.label} {...metric} />
            ))}
            <Panel className="flex flex-col justify-center">
              <ShareBar label="NPR in" part={collected} total={collected + outstanding} />
              <p className="mt-1.5 text-[11.5px] text-muted-foreground">{npr(outstanding)} still owed</p>
            </Panel>
          </div>

          <div className="grid gap-5 xl:grid-cols-2">
            <Panel action={<ViewAllLink href="/platform/hostels" tone="team" />} title="New hostels">
              {hostels.length === 0 ? (
                <EmptyInline label="No hostel applications yet." />
              ) : (
                <>
                  <div className="space-y-1">
                    {hostels.map((hostel) => (
                      <div className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-muted" key={hostel.id}>
                        <InitialsAvatar name={hostel.name} size="sm" tone="team" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <p className="truncate text-[13.5px] font-semibold text-foreground">{hostel.name}</p>
                            {hostel.isDemoData ? <DemoDataBadge label={hostel.demoDataLabel} /> : null}
                          </div>
                          <p className="truncate text-[12px] text-muted-foreground">
                            {[hostel.location.area, hostel.location.city].filter(Boolean).join(", ")}
                            {hostel.owner?.name ? ` · ${hostel.owner.name}` : ""}
                          </p>
                        </div>
                        <SoftBadge tone={statusToneFromLabel(hostel.status)}>{hostel.status.replaceAll("_", " ")}</SoftBadge>
                      </div>
                    ))}
                  </div>
                  <ListPager page={hostelPage} onPageChange={setHostelPage} pageSize={RECENT_ROW_LIMIT} total={totalHostelCount} />
                </>
              )}
            </Panel>

            <Panel action={<ViewAllLink href="/platform/payments" tone="team" />} title="Recent payments">
              {payments.length === 0 ? (
                <EmptyInline label="No payments recorded yet." />
              ) : (
                <>
                  <div className="space-y-1">
                    {payments.map((payment) => (
                      <div className="flex items-center gap-3 rounded-xl px-2 py-2 transition hover:bg-muted" key={payment.id}>
                        <WalletMark name={payment.provider} size={36} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[13.5px] font-semibold text-foreground">{payment.hostelName}</p>
                          <p className="truncate text-[12px] text-muted-foreground">
                            {payment.provider.replaceAll("_", " ")} · {shortDate(payment.paidAt)}
                          </p>
                        </div>
                        <div className="shrink-0 text-right">
                          <p className="text-[13.5px] font-semibold tabular-nums text-foreground">{npr(payment.paidAmount)}</p>
                          <SoftBadge tone={statusToneFromLabel(payment.status)}>{payment.status.replaceAll("_", " ")}</SoftBadge>
                        </div>
                      </div>
                    ))}
                  </div>
                  <ListPager page={paymentPage} onPageChange={setPaymentPage} pageSize={RECENT_ROW_LIMIT} total={paymentsResource.data?.pagination.total ?? 0} />
                </>
              )}
            </Panel>
          </div>

          <div className="grid gap-5 xl:grid-cols-[1.55fr_1fr]">
            <Panel
              action={
                <span className="text-[11.5px] font-semibold text-muted-foreground">
                  Last {(series?.bucketDays ?? 7) * (series?.labels.length ?? 5)} days
                </span>
              }
              title="Trends"
            >
              <div className="grid gap-3 md:grid-cols-3">
                {[
                  {
                    label: "Hostels joined",
                    trend: trends.totalHostels,
                    value: (report?.totalHostels ?? 0).toLocaleString(),
                    values: series?.hostels ?? [],
                  },
                  {
                    label: "Inquiries",
                    trend: trends.inquiries,
                    value: (report?.inquiries ?? 0).toLocaleString(),
                    values: series?.inquiries ?? [],
                  },
                  {
                    label: "Revenue (NPR)",
                    trend: trends.platformPayments,
                    value: compactNpr(report?.platformPayments ?? 0),
                    values: series?.revenue ?? [],
                  },
                ].map((chart) => {
                  const change = chart.trend?.changePercent ?? null;

                  return (
                    <div className="rounded-xl bg-muted/40 p-3.5" key={chart.label}>
                      <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{chart.label}</p>
                      <p className="mt-1 flex items-baseline gap-1.5">
                        <span className="text-xl font-bold text-foreground">{chart.value}</span>
                        {change === null ? null : (
                          <span className={`text-[11px] font-semibold ${change < 0 ? "text-rose-600" : "text-role-team"}`}>
                            {change < 0 ? "↓" : "↑"} {Math.abs(change)}%
                          </span>
                        )}
                      </p>
                      <div className="mt-3">
                        <AreaSparkline
                          labels={chartLabels}
                          stroke="var(--role-team)"
                          values={chart.values.length > 0 ? chart.values : [0, 0, 0, 0, 0]}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Panel>

            <Panel action={<ViewAllLink href="/platform/audit-logs" tone="team" />} title="Latest activity">
              {auditLogs.length === 0 ? (
                <EmptyInline label="No audit activity recorded yet." />
              ) : (
                <div className="space-y-1">
                  {auditLogs.map((log) => (
                    <div className="flex items-start gap-3 rounded-xl px-2 py-2" key={log.id}>
                      <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-role-team-soft text-role-team">
                        <ScrollText className="size-4" />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-[13.5px] font-semibold text-foreground">
                          {humanizeAction(log.action)}
                          {log.hostelLabel ? ` — ${log.hostelLabel}` : ""}
                        </p>
                        <p className="truncate text-[12px] text-muted-foreground">
                          {log.actorLabel} · {log.entityType.toLowerCase()}
                        </p>
                      </div>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{relativeTime(log.createdAt)}</span>
                    </div>
                  ))}
                </div>
              )}
            </Panel>
          </div>
        </>
      ) : null}
    </div>
  );
});
