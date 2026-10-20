"use client";

import React from "react";
import { BarChart3 } from "@/components/icons";
import { downloadFile } from "@/lib/downloads/downloader";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { ExportMenu } from "@/components/export-menu";
import { currency, EmptyState } from "./shared-ui";
import { MetricCard } from "./portal-dashboard-ui";
import { PlatformQuestionCallPanel } from "./platform-questioncall-panel";
import { Message, PageHeader, type ReportRecord } from "./core-portal-shared";

const PLATFORM_REPORT_EXPORT = "/api/v1/platform/reports/export";

const EXPORTS = [
  { id: "payments", label: "Payments" },
  { id: "complaints", label: "Complaints" },
  { id: "hostels", label: "Hostels (today)" },
  { id: "residents", label: "Residents (today)" },
];

/** `openListingFlags` → `Open listing flags`. */
function readable(key: string) {
  const words = key.replace(/([A-Z])/g, " $1").trim().toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const PlatformReportsPageContent = React.memo(
  function PlatformReportsPageContent() {
    const reportResource = usePortalResource<{ report: ReportRecord }>(
      platformEndpoints.dashboardReport,
      { errorMessage: "Could not load report." },
    );
    // A PLATFORM_MODERATOR reads reports but cannot export them (PHASES.md
    // §5.1), so the menu is hidden for them — the API refuses either way.
    const meResource = usePortalResource<{ user: { role: string } }>(
      platformEndpoints.currentUser,
      { errorMessage: "" },
    );

    const report = reportResource.data?.report ?? null;
    const message = reportResource.message;
    const canExport = meResource.data?.user.role === "SUPERADMIN";
    // The headline figures are the report's plain numbers; its series and
    // trends feed the Dashboard's charts and are left to it.
    const figures = Object.entries(report ?? {}).filter(
      (entry): entry is [string, number] => typeof entry[1] === "number",
    );

    return (
      <div className="mx-auto max-w-[1448px] space-y-5">
        <PageHeader
          action={
            canExport ? (
              <ExportMenu
                choices={EXPORTS}
                onExport={({ choice, format, months }) =>
                  void downloadFile({
                    fileName: `${choice}-report.${format}`,
                    label: EXPORTS.find((entry) => entry.id === choice)?.label ?? "Report",
                    mimeType: format === "pdf" ? "application/pdf" : "text/csv",
                    scope: "platform-reports",
                    url: `${PLATFORM_REPORT_EXPORT}?report=${choice}&format=${format}&months=${months}`,
                  })
                }
                ranges
              />
            ) : null
          }
          description="The platform's headline figures, and exports."
          icon={BarChart3}
          title="Reports"
        />
        <Message value={message} />

        {report === null ? (
          <EmptyState label="Report data is not loaded." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {figures.map(([key, value]) => (
              <MetricCard
                key={key}
                label={readable(key)}
                value={
                  /payment|amount|due/i.test(key) ? currency(value) : value.toLocaleString()
                }
              />
            ))}
          </div>
        )}

        <PlatformQuestionCallPanel canExport={canExport} />
      </div>
    );
  },
);
