"use client";

import React from "react";
import { GraduationCap } from "@/components/icons";

import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { usePortalResource } from "@/lib/portal-query";
import { StatTile } from "./report-widgets";

type QuestionCallAnalytics = {
  byHostel: Array<{
    clicks: number;
    conversionRate: number;
    conversions: number;
    hostelId: string;
    hostelName: string;
  }>;
  summary: {
    conversionRate: number;
    conversions: number;
    totalClicks: number;
    uniqueResidents: number;
  };
};

export const QUESTIONCALL_ANALYTICS_ENDPOINT = "/api/v1/platform/questioncall/analytics";

function percent(value: number) {
  return `${(value * 100).toFixed(1)}%`;
}

export const PlatformQuestionCallPanel = React.memo(function PlatformQuestionCallPanel({
  canExport,
}: {
  canExport: boolean;
}) {
  const resource = usePortalResource<QuestionCallAnalytics>(
    QUESTIONCALL_ANALYTICS_ENDPOINT,
    { errorMessage: "Could not load QuestionCall analytics." },
  );

  const analytics = resource.data ?? null;
  const rows = analytics?.byHostel ?? [];

  return (
    <Panel
      action={
        canExport ? (
          <a
            className="inline-flex items-center rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-semibold text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-role-platform"
            href={`${QUESTIONCALL_ANALYTICS_ENDPOINT}?format=csv`}
          >
            Export CSV
          </a>
        ) : undefined
      }
      title="QuestionCall engagement"
    >
      {resource.state === "loading" ? <LoadingRows /> : null}
      {resource.state === "error" ? (
        <EmptyState label="QuestionCall analytics could not be loaded." />
      ) : null}

      {analytics ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              hint="Student taps on the study link"
              label="Clicks"
              value={analytics.summary.totalClicks}
            />
            <StatTile
              hint="Distinct residents"
              label="Residents"
              value={analytics.summary.uniqueResidents}
            />
            <StatTile
              hint="Confirmed by QuestionCall"
              label="Conversions"
              tone="good"
              value={analytics.summary.conversions}
            />
            <StatTile
              hint="Clicks that signed up"
              label="Conversion rate"
              value={percent(analytics.summary.conversionRate)}
            />
          </div>

          <div className="mt-4 overflow-x-auto">
            {rows.length === 0 ? (
              <EmptyState label="No QuestionCall clicks recorded yet." />
            ) : (
              <table className="w-full min-w-[480px] text-[13px]">
                <caption className="sr-only">
                  QuestionCall clicks and conversions per hostel
                </caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="py-2 pr-3 font-medium" scope="col">
                      Hostel
                    </th>
                    <th className="py-2 pr-3 text-right font-medium" scope="col">
                      Clicks
                    </th>
                    <th className="py-2 pr-3 text-right font-medium" scope="col">
                      Conversions
                    </th>
                    <th className="py-2 text-right font-medium" scope="col">
                      Rate
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr className="border-b border-border/60" key={row.hostelId}>
                      <th
                        className="py-2 pr-3 text-left font-medium text-foreground"
                        scope="row"
                      >
                        {row.hostelName}
                      </th>
                      <td className="py-2 pr-3 text-right tabular-nums">{row.clicks}</td>
                      <td className="py-2 pr-3 text-right tabular-nums">
                        {row.conversions}
                      </td>
                      <td className="py-2 text-right tabular-nums">
                        <span className="inline-flex items-center justify-end gap-2">
                          <span className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
                            <span
                              className="block h-full rounded-full bg-brand-teal"
                              style={{ width: `${Math.min(100, Math.round(row.conversionRate * 100))}%` }}
                            />
                          </span>
                          {percent(row.conversionRate)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}
    </Panel>
  );
});

export const QuestionCallIcon = GraduationCap;
