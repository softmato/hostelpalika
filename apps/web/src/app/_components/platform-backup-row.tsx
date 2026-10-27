"use client";

import { memo } from "react";

import { SoftBadge } from "@/app/_components/portal-dashboard-ui";
import { usePortalResource } from "@/lib/portal-query";
import { formatHostelDate } from "@hostel/shared/calendar/bs";

type Status = {
  backup: { at: string; collections: number; documents: number; file: string; stale: boolean } | null;
  drill: { at: string; file: string; mismatches: { collection: string }[]; ok: boolean } | null;
  lastPassedDrill: { at: string; file: string } | null;
};

const when = (iso: string) =>
  `${formatHostelDate(iso, "")}, ${new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kathmandu" })}`;

/**
 * Platform backup on the superadmin dashboard (docs/BACKUP.md I2). Says only
 * what was reported: a backup is "made" when the workflow posted it, and
 * "verified" only once a restore drill has passed.
 */
export const PlatformBackupRow = memo(function PlatformBackupRow() {
  const { data } = usePortalResource<Status>("/api/v1/platform/backup-status", { errorMessage: "" });

  if (!data) return null;

  const { backup, drill, lastPassedDrill } = data;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border bg-card px-4 py-3 text-[13px]">
      <span className="font-semibold text-foreground">Platform backup</span>
      {backup ? (
        <span className="text-muted-foreground">
          Last backup {when(backup.at)} · {backup.collections} collections
        </span>
      ) : (
        <span className="text-muted-foreground">No backup reported yet</span>
      )}
      {backup?.stale || !backup ? <SoftBadge tone="rose">Not in the last 30 hours</SoftBadge> : null}
      {drill && !drill.ok ? (
        <SoftBadge tone="rose">Last drill failed · {drill.mismatches.length} collections off</SoftBadge>
      ) : null}
      {lastPassedDrill ? (
        <SoftBadge tone="green">Restore drill passed {formatHostelDate(lastPassedDrill.at, "")}</SoftBadge>
      ) : (
        <SoftBadge tone="amber">Not verified — no restore drill has passed</SoftBadge>
      )}
    </div>
  );
});
