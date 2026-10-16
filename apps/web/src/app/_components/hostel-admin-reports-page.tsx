"use client";

import React, { useMemo, useState } from "react";
import { BarChart3 } from "@/components/icons";
import { EmptyState, LoadingRows, Panel, StatusBadge } from "@/app/_components/shared-ui";
import { downloadFile } from "@/lib/downloads/downloader";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import {
  Breakdown,
  CollectionChart,
  DataTable,
  StatTile,
  money,
  type CountMap,
  type MonthlyPoint,
} from "./report-widgets";
import {
  HostelAdminAttendanceAnalyticsPanel,
  HostelAdminFoodAnalyticsPanel,
} from "./hostel-admin-operations-analytics";
import { Message, PageHeader } from "./portal-shared";

const HOSTEL_ADMIN_REPORT_EXPORT = "/api/v1/hostel-admin/reports/export";

const REPORT_EXPORTS = [
  { label: "Residents CSV", report: "residents" },
  { label: "Collection CSV", report: "payments" },
  { label: "Complaints CSV", report: "complaints" },
  { label: "Occupancy CSV", report: "occupancy" },
];

type Overview = {
  overview: {
    complaints: {
      averageResolutionDays: number | null;
      byCategory: CountMap;
      byStatus: CountMap;
      open: number;
      resolved: number;
      slaBreached: number;
      total: number;
    };
    food: { averageRating: number | null; feedbackCount: number };
    generatedAt: string;
    inquiries: {
      byStatus: CountMap;
      conversionRate: number;
      converted: number;
      total: number;
    };
    maintenance: {
      byCategory: CountMap;
      byStatus: CountMap;
      completed: number;
      open: number;
      total: number;
    };
    months: string[];
    nightStatus: CountMap;
    occupancy: {
      byStatus: CountMap;
      occupancyRate: number;
      occupiedBeds: number;
      residents: number;
      totalBeds: number;
      vacantBeds: number;
    };
    payments: {
      byMethod: CountMap;
      byStatus: CountMap;
      collectionRate: number;
      monthly: MonthlyPoint[];
      outstanding: number;
      pendingProofs: number;
      recent: Array<{
        dueAmount: number;
        dueDate: string | null;
        id: string;
        method: string;
        month: string;
        paidAmount: number;
        paidDate: string | null;
        residentName: string;
        roomType: string;
        status: string;
      }>;
      selectedMonth: {
        collectionRate: number;
        month: string;
        outstanding: number;
        totalDue: number;
        totalPaid: number;
      };
      totalDue: number;
      totalPaid: number;
    };
    referrals: {
      byStatus: CountMap;
      joined: number;
      rewardApprovedAmount: number;
      rewardPaidAmount: number;
      rewardTotalAmount: number;
      total: number;
    };
    visibility: {
      publicViewsLast30Days: number;
      totalPublicViews: number;
      uniquePublicVisitors: number;
    };
  };
};

function shortDate(value: string | null) {
  return value
    ? new Date(value).toLocaleDateString("en", { day: "numeric", month: "short" })
    : "—";
}

function rateTone(rate: number) {
  if (rate >= 85) return "good" as const;
  if (rate >= 60) return "warn" as const;
  return "bad" as const;
}

export const HostelAdminReportsPageContent = React.memo(
  function HostelAdminReportsPageContent() {
    const [month, setMonth] = useState("");
    const resource = usePortalResource<Overview>(
      hostelAdminEndpoints.reportsOverview(month || undefined),
      { errorMessage: "Could not load reports." },
    );

    const data = resource.data?.overview ?? null;
    const months = useMemo(() => data?.months ?? [], [data]);

    if (resource.state === "loading" && !data) {
      return (
        <div className="mx-auto max-w-[1448px] space-y-6">
          <PageHeader
            description="Every service in the hostel, reported from its live records."
            icon={BarChart3}
            title="Reports"
          />
          <Panel>
            <LoadingRows />
          </Panel>
        </div>
      );
    }

    if (!data) {
      return (
        <div className="mx-auto max-w-[1448px] space-y-6">
          <PageHeader
            description="Every service in the hostel, reported from its live records."
            icon={BarChart3}
            title="Reports"
          />
          <Message value={resource.message} />
          <Panel>
            <EmptyState label="Reports could not be loaded." />
          </Panel>
        </div>
      );
    }

    const {
      complaints,
      food,
      inquiries,
      maintenance,
      occupancy,
      payments,
      referrals,
      visibility,
    } = data;
    const selected = payments.selectedMonth;

    return (
      <div className="mx-auto max-w-[1448px] space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <PageHeader
            description="Every service in the hostel, reported from its live records — payments, complaints, maintenance, food, occupancy and growth."
            icon={BarChart3}
            title="Reports"
          />
          <label className="grid gap-1.5 text-xs font-semibold text-muted-foreground">
            Billing month
            <select
              className="h-10 rounded-md border border-border bg-background px-3 text-sm font-normal text-foreground outline-none focus:border-role-admin"
              onChange={(event) => setMonth(event.target.value)}
              value={month}
            >
              <option value="">Latest ({months[months.length - 1] ?? "—"})</option>
              {[...months].reverse().map((option) => (
                <option key={option} value={option}>
                  {option}
                </option>
              ))}
            </select>
          </label>
        </div>
        <Message value={resource.message} />

        {/* Aggregates only — no CSV here carries a resident's name or phone. */}
        {/*
          Buttons, not links. An `<a href>` to an API route gives no feedback at
          all until the browser's own download chip appears — several silent
          seconds on a slow query — and it *navigates* on failure, so an expired
          session answered "download my report" with a raw JSON body rendered as
          a page. `downloadFile` streams it with a live row in the global
          toaster and keeps a failure on the page as a toast.
        */}
        <nav aria-label="Report exports" className="flex flex-wrap gap-2">
          {REPORT_EXPORTS.map((entry) => (
            <button
              className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-role-admin"
              key={entry.report}
              onClick={() =>
                void downloadFile({
                  fileName: `${entry.report}-report.csv`,
                  label: entry.label,
                  mimeType: "text/csv",
                  scope: "hostel-admin-reports",
                  url: `${HOSTEL_ADMIN_REPORT_EXPORT}?report=${entry.report}`,
                })
              }
              type="button"
            >
              {entry.label}
            </button>
          ))}
        </nav>

        {/* ---- Headline health of the hostel ---- */}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <StatTile
            hint={`${occupancy.occupiedBeds} of ${occupancy.totalBeds} beds filled`}
            label="Occupancy"
            tone={rateTone(occupancy.occupancyRate)}
            value={`${occupancy.occupancyRate}%`}
          />
          <StatTile
            hint={`${money(payments.totalPaid)} collected of ${money(payments.totalDue)} billed`}
            label="Collection rate"
            tone={rateTone(payments.collectionRate)}
            value={`${payments.collectionRate}%`}
          />
          <StatTile
            hint={`${payments.pendingProofs} payment proof(s) awaiting review`}
            label="Outstanding dues"
            tone={payments.outstanding > 0 ? "warn" : "good"}
            value={money(payments.outstanding)}
          />
          <StatTile
            hint={`${complaints.open} complaints and ${maintenance.open} repairs open`}
            label="Open issues"
            tone={complaints.slaBreached > 0 ? "bad" : "default"}
            value={complaints.open + maintenance.open}
          />
        </div>

        {/* ---- Payments: sourced from the Payment ledger the Payments tab writes ---- */}
        <Panel title="Payments Flow">
          <div className="grid gap-5 xl:grid-cols-[1.15fr_1fr]">
            <div>
              <p className="mb-3 text-xs text-muted-foreground">
                Billed vs collected per month, taken from the payment records residents
                and admins have actually settled.
              </p>
              <CollectionChart points={payments.monthly} />
            </div>
            <div className="grid content-start gap-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <StatTile
                  hint={selected.month}
                  label="Billed this month"
                  value={money(selected.totalDue)}
                />
                <StatTile
                  hint={`${selected.collectionRate}% collected`}
                  label="Collected this month"
                  tone={rateTone(selected.collectionRate)}
                  value={money(selected.totalPaid)}
                />
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Payment status
                </p>
                <Breakdown emptyLabel="No payment records yet." map={payments.byStatus} />
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Payment method
                </p>
                <Breakdown emptyLabel="No method recorded yet." map={payments.byMethod} />
              </div>
            </div>
          </div>
          <div className="mt-5 border-t border-border pt-4">
            <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Latest ledger entries
            </p>
            <DataTable
              columns={["Resident", "Month", "Billed", "Paid", "Method", "Due", "Status"]}
              emptyLabel="No payments recorded yet."
              rows={payments.recent.map((row) => [
                <span key="name">
                  {row.residentName}
                  <span className="block text-xs text-muted-foreground">
                    {row.roomType}
                  </span>
                </span>,
                row.month,
                money(row.dueAmount),
                money(row.paidAmount),
                row.method ? row.method.replaceAll("_", " ") : "—",
                shortDate(row.dueDate),
                <StatusBadge key="status">{row.status}</StatusBadge>,
              ])}
            />
          </div>
        </Panel>

        {/* ---- Service-by-service reports ---- */}
        <div className="grid gap-5 xl:grid-cols-3">
          <Panel title="Complaints">
            <div className="grid grid-cols-3 gap-2">
              <StatTile label="Total" value={complaints.total} />
              <StatTile
                label="Open"
                tone={complaints.open > 0 ? "warn" : "good"}
                value={complaints.open}
              />
              <StatTile
                label="SLA breached"
                tone={complaints.slaBreached > 0 ? "bad" : "good"}
                value={complaints.slaBreached}
              />
            </div>
            <p className="mt-3 text-xs text-muted-foreground">
              Average resolution:{" "}
              <span className="font-semibold text-foreground">
                {complaints.averageResolutionDays === null
                  ? "no resolved complaints yet"
                  : `${complaints.averageResolutionDays} days`}
              </span>
            </p>
            <div className="mt-4 grid gap-4">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  By status
                </p>
                <Breakdown emptyLabel="No complaints yet." map={complaints.byStatus} />
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  By category
                </p>
                <Breakdown emptyLabel="No complaints yet." map={complaints.byCategory} />
              </div>
            </div>
          </Panel>

          <Panel title="Maintenance">
            <div className="grid grid-cols-3 gap-2">
              <StatTile label="Total" value={maintenance.total} />
              <StatTile
                label="Open"
                tone={maintenance.open > 0 ? "warn" : "good"}
                value={maintenance.open}
              />
              <StatTile label="Completed" tone="good" value={maintenance.completed} />
            </div>
            <div className="mt-4 grid gap-4">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  By status
                </p>
                <Breakdown emptyLabel="No requests yet." map={maintenance.byStatus} />
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  By trade
                </p>
                <Breakdown emptyLabel="No requests yet." map={maintenance.byCategory} />
              </div>
            </div>
          </Panel>

          <Panel title="Residents & Food">
            <div className="grid grid-cols-3 gap-2">
              <StatTile label="Residents" value={occupancy.residents} />
              <StatTile label="Vacant beds" value={occupancy.vacantBeds} />
              <StatTile
                hint={`${food.feedbackCount} response(s)`}
                label="Food rating"
                tone={
                  food.averageRating === null
                    ? "default"
                    : food.averageRating >= 4
                      ? "good"
                      : food.averageRating >= 3
                        ? "warn"
                        : "bad"
                }
                value={food.averageRating === null ? "—" : `${food.averageRating}/5`}
              />
            </div>
            <div className="mt-4 grid gap-4">
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Resident status
                </p>
                <Breakdown emptyLabel="No residents yet." map={occupancy.byStatus} />
              </div>
              <div>
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Night attendance
                </p>
                <Breakdown
                  emptyLabel="No attendance recorded yet."
                  map={data.nightStatus}
                />
              </div>
            </div>
          </Panel>
        </div>

        {/* ---- Growth ---- */}
        <div className="grid gap-5 xl:grid-cols-3">
          <Panel title="Inquiries">
            <div className="grid grid-cols-3 gap-2">
              <StatTile label="Total" value={inquiries.total} />
              <StatTile label="Converted" tone="good" value={inquiries.converted} />
              <StatTile
                label="Conversion"
                tone={rateTone(inquiries.conversionRate)}
                value={`${inquiries.conversionRate}%`}
              />
            </div>
            <div className="mt-4">
              <Breakdown emptyLabel="No inquiries yet." map={inquiries.byStatus} />
            </div>
          </Panel>

          <Panel title="Referrals">
            <div className="grid grid-cols-3 gap-2">
              <StatTile label="Total" value={referrals.total} />
              <StatTile label="Joined" tone="good" value={referrals.joined} />
              <StatTile
                hint={`${money(referrals.rewardPaidAmount)} paid out`}
                label="Rewards"
                value={money(referrals.rewardTotalAmount)}
              />
            </div>
            <div className="mt-4">
              <Breakdown emptyLabel="No referrals yet." map={referrals.byStatus} />
            </div>
          </Panel>

          <Panel title="Public Listing">
            <div className="grid grid-cols-3 gap-2">
              <StatTile label="Views (30d)" value={visibility.publicViewsLast30Days} />
              <StatTile label="Total views" value={visibility.totalPublicViews} />
              <StatTile label="Unique visitors" value={visibility.uniquePublicVisitors} />
            </div>
            <p className="mt-4 text-xs text-muted-foreground">
              Generated {new Date(data.generatedAt).toLocaleString()}.
            </p>
          </Panel>
        </div>

        {/* Fetched separately so a hostel with no cook portal or no location
            tracking still gets the rest of the page. */}
        <HostelAdminFoodAnalyticsPanel />
        <HostelAdminAttendanceAnalyticsPanel />
      </div>
    );
  },
);
