"use client";

import Link from "next/link";

import { Glyph } from "@/components/glyph";

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

  const totals = rows.reduce(
    (sum, row) => ({
      beds: sum.beds + row.beds,
      collected: sum.collected + row.collected,
      complaints: sum.complaints + row.openComplaints,
      due: sum.due + row.due,
      residents: sum.residents + row.residents,
    }),
    { beds: 0, collected: 0, complaints: 0, due: 0, residents: 0 },
  );

  return (
    <SectionCard
      description={`${rows.length} hostels · ${month}. Open one to work in it.`}
      title="Your hostels"
    >
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl bg-muted/40 p-4 sm:grid-cols-4">
        <HostelStat label="Residents / beds" value={`${totals.residents} / ${totals.beds}`} />
        <HostelStat label="Collected" value={rupees(totals.collected)} />
        <HostelStat label="Due" value={totals.due > 0 ? rupees(totals.due) : "—"} warning={totals.due > 0} />
        <HostelStat label="Open complaints" value={totals.complaints.toLocaleString()} warning={totals.complaints > 0} />
      </div>
      <ul className="mt-3 divide-y divide-border overflow-hidden rounded-xl border border-border">
        {rows.map((row) => (
          <li key={row.id}>
            <Link
              className="group grid grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-brand-teal md:grid-cols-[auto_minmax(0,1.6fr)_repeat(4,minmax(0,1fr))_auto]"
              href={`/${encodeURIComponent(row.slug)}/admin/dashboard`}
            >
              <span className="flex size-9 items-center justify-center rounded-lg bg-brand-teal/10 text-brand-teal">
                <Glyph className="size-[18px]" name={row.isBranch ? "branch" : "hostel"} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-sm font-semibold text-foreground">{row.name}</span>
                <span className="block text-xs text-muted-foreground">{row.isBranch ? "Branch" : "Main hostel"}</span>
              </span>
              <Glyph className="size-4 text-muted-foreground transition-colors group-hover:text-brand-teal md:order-last" name="open" />
              <span className="col-span-3 grid grid-cols-4 gap-3 text-sm md:contents">
                <HostelStat label="Residents" value={`${row.residents}`} detail={row.occupancyPercent === null ? undefined : `${row.occupancyPercent}% full`} />
                <HostelStat label="Collected" value={rupees(row.collected)} />
                <HostelStat label="Due" value={row.due > 0 ? rupees(row.due) : "—"} warning={row.due > 0} />
                <HostelStat label="Complaints" value={row.openComplaints.toLocaleString()} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
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
        className={`mt-1 block truncate font-semibold tabular-nums ${warning ? "text-warning" : "text-foreground"}`}
      >
        {value}
      </span>
      {detail ? (
        <span className="block text-[11px] text-muted-foreground">{detail}</span>
      ) : null}
    </span>
  );
}
