"use client";

import { Building2 } from "lucide-react";

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
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wide text-muted-foreground">
              <th className="py-2 pr-3 font-semibold">Hostel</th>
              <th className="py-2 pr-3 text-right font-semibold">Residents</th>
              <th className="py-2 pr-3 text-right font-semibold">Occupancy</th>
              <th className="py-2 pr-3 text-right font-semibold">Collected</th>
              <th className="py-2 pr-3 text-right font-semibold">Due</th>
              <th className="py-2 pr-3 text-right font-semibold">Complaints</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="py-2.5 pr-3">
                  <a
                    className="inline-flex items-center gap-2 font-semibold text-foreground hover:text-brand-teal"
                    href={`/${encodeURIComponent(row.slug)}/admin/dashboard`}
                  >
                    <Building2 className="size-4 text-muted-foreground" />
                    {row.name}
                    {row.isBranch ? (
                      <span className="text-[11px] font-medium text-muted-foreground">branch</span>
                    ) : null}
                  </a>
                </td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{row.residents}</td>
                <td className="py-2.5 pr-3 text-right tabular-nums">
                  {row.occupancyPercent === null ? "—" : `${row.occupancyPercent}%`}
                  <span className="block text-[11px] text-muted-foreground">{row.beds} beds</span>
                </td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{rupees(row.collected)}</td>
                <td className={`py-2.5 pr-3 text-right tabular-nums ${row.due > 0 ? "text-warning" : ""}`}>
                  {row.due > 0 ? rupees(row.due) : "—"}
                </td>
                <td className="py-2.5 pr-3 text-right tabular-nums">{row.openComplaints}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}
