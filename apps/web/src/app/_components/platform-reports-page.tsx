"use client";

import React from "react";
import { BarChart3 } from "@/components/icons";
import { downloadFile } from "@/lib/downloads/downloader";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { PlatformQuestionCallPanel } from "./platform-questioncall-panel";
import { Message, PageHeader, ReportGrid, type ReportRecord } from "./portal-shared";

const PLATFORM_REPORT_EXPORT = "/api/v1/platform/reports/export";

const EXPORTS = [
  { label: "Hostels CSV", report: "hostels" },
  { label: "Residents CSV", report: "residents" },
  { label: "Payments CSV", report: "payments" },
  { label: "Complaints CSV", report: "complaints" },
];

export const PlatformReportsPageContent = React.memo(
  function PlatformReportsPageContent() {
    const reportResource = usePortalResource<{ report: ReportRecord }>(
      platformEndpoints.dashboardReport,
      { errorMessage: "Could not load report." },
    );
    // A PLATFORM_MODERATOR reads reports but cannot export them (PHASES.md
    // §5.1), so the links are hidden for them — the API refuses either way.
    const meResource = usePortalResource<{ user: { role: string } }>(
      platformEndpoints.currentUser,
      { errorMessage: "" },
    );

    const report = reportResource.data?.report ?? null;
    const message = reportResource.message;
    const canExport = meResource.data?.user.role === "SUPERADMIN";

    return (
      <div className="mx-auto max-w-[1448px] space-y-6">
        <PageHeader
          description="Platform-wide pilot readiness metrics."
          icon={BarChart3}
          title="Reports"
        />
        <Message value={message} />

        {canExport ? (
          <nav aria-label="Report exports" className="flex flex-wrap gap-2">
            {EXPORTS.map((entry) => (
              <button
                className="inline-flex items-center rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground transition hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-role-platform"
                key={entry.report}
                onClick={() =>
                  void downloadFile({
                    fileName: `${entry.report}-report.csv`,
                    label: entry.label,
                    mimeType: "text/csv",
                    scope: "platform-reports",
                    url: `${PLATFORM_REPORT_EXPORT}?report=${entry.report}`,
                  })
                }
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </nav>
        ) : null}

        <ReportGrid report={report} />
        <PlatformQuestionCallPanel canExport={canExport} />
      </div>
    );
  },
);
