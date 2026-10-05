"use client";

import Link from "next/link";

import { ArrowUpRight, Building2 } from "lucide-react";

import { usePortalResource } from "@/lib/portal-query";
import { bsMonthName } from "@hostel/shared/calendar/bs";

import { SectionCard } from "./portal-dashboard-ui";

type Summary = {
  hostels: Array<{
    beds: number;
    collected: number;
    due: number;
    id: string;
    isBranch: boolean;
    name: string;
    occupancyPercent: number | null;
    openComplaints: number;
    residents: number;
    slug: string;
    status: string;
  }>;
  period: string;
};

function rupees(amount: number) {
  return `Rs ${amount.toLocaleString("en-IN")}`;
}

/**
 * Every hostel the owner runs, side by side — the one place the dashboard looks
 * across branches. Each row opens that hostel's own workspace, where every
 * other tab works on it alone. Renders nothing for an owner with one hostel.
 */
export function HostelBranchesCard() {
  const resource = usePortalResource<Summary>("/api/v1/hostel-admin/branches/summary");
  const rows = resource.data?.hostels ?? [];

  if (rows.length < 2) return null;

  const month = bsMonthName(Number(resource.data?.period.slice(5, 7) ?? 1));

  return (
    <SectionCard
      description={`Residents, beds, ${month}'s collection and open complaints — open one to work in it.`}
      title="Your hostels"
    >
      <div className="grid gap-3">
        {rows.map((row) => (
          <Link
            className="group flex flex-col gap-4 rounded-xl border border-border/80 bg-background/70 p-4 transition-colors hover:border-brand-teal/40 hover:bg-brand-teal/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-teal sm:p-5"
            href={`/${encodeURIComponent(row.slug)}/admin/dashboard`}
            key={row.id}
          >
            <span className="flex items-center gap-3">
              <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-brand-teal/10 text-brand-teal">
                <Building2 aria-hidden="true" className="size-5" />
              </span>
              <span className="min-w-0 flex-1 truncate font-semibold text-foreground">
                {row.name}
              </span>
              <ArrowUpRight
                aria-hidden="true"
                className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-brand-teal"
              />
            </span>
            <span className="grid grid-cols-2 gap-x-4 gap-y-3 border-t border-border/70 pt-4 text-sm sm:grid-cols-3 lg:grid-cols-5">
              <HostelStat label="Residents" value={row.residents.toLocaleString()} />
              <HostelStat
                label="Occupancy"
                value={row.occupancyPercent === null ? "—" : `${row.occupancyPercent}%`}
                detail={`${row.beds} beds`}
              />
              <HostelStat label="Collected" value={rupees(row.collected)} />
              <HostelStat
                label="Due"
                value={row.due > 0 ? rupees(row.due) : "—"}
                warning={row.due > 0}
              />
              <HostelStat
                label="Complaints"
                value={row.openComplaints.toLocaleString()}
              />
            </span>
          </Link>
        ))}
      </div>
    </SectionCard>
  );
}

function HostelStat({
  detail,
  label,
  value,
  warning = false,
}: {
  detail?: string;
  label: string;
  value: string;
  warning?: boolean;
}) {
  return (
    <span className="min-w-0">
      <span className="block text-xs text-muted-foreground">{label}</span>
      <span
        className={`mt-1 block font-semibold tabular-nums ${warning ? "text-warning" : "text-foreground"}`}
      >
        {value}
      </span>
      {detail ? (
        <span className="block text-[11px] text-muted-foreground">{detail}</span>
      ) : null}
    </span>
  );
}
