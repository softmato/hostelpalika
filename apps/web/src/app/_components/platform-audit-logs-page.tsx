"use client";

import { formatHostelDate, formatHostelDateTime } from "@hostel/shared/calendar/bs";

import { ScrollText } from "@/components/icons";
import { memo, useMemo, useState } from "react";

import { EmptyState, Panel } from "@/app/_components/shared-ui";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { Message, PageHeader } from "./core-portal-shared";
import { FactChip } from "./platform-page-ui";
import { SearchField } from "./portal-dashboard-ui";

type AuditLogRecord = {
  action: string;
  actorId: string | null;
  actorLabel: string;
  createdAt: string | null;
  entityId: string;
  entityType: string;
  hostelId: string | null;
  hostelLabel: string | null;
  id: string;
  ipAddress: string | null;
  metadata: Record<string, unknown>;
};

function formatTimestamp(value: string | null) {
  if (!value) {
    return "-";
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : formatHostelDateTime(date);
}

function metadataSummary(metadata: Record<string, unknown>) {
  const entries = Object.entries(metadata ?? {});
  if (entries.length === 0) {
    return "-";
  }

  return entries.map(([key, value]) => `${key}: ${String(value)}`).join(", ");
}

/** `HOSTEL_APPROVED` → `Hostel approved`. */
function humanize(action: string) {
  const words = action.toLowerCase().replaceAll("_", " ");

  return words.charAt(0).toUpperCase() + words.slice(1);
}

function dayHeading(value: string | null) {
  if (!value) return "Undated";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Undated"
    : formatHostelDate(date);
}

export const PlatformAuditLogsPageContent = memo(function PlatformAuditLogsPageContent() {
  const logsResource = usePortalResource<{ logs: AuditLogRecord[] }>(
    platformEndpoints.auditLogs,
    { errorMessage: "Could not load audit logs." },
  );
  const [query, setQuery] = useState("");
  const [entity, setEntity] = useState("");

  const logs = useMemo(() => logsResource.data?.logs ?? [], [logsResource.data]);
  const message = logsResource.message;
  const entities = useMemo(() => Array.from(new Set(logs.map((log) => log.entityType))), [logs]);

  // Newest first, as served, grouped under the day each happened; the heading
  // sits outside the card.
  const days = useMemo(() => {
    const term = query.trim().toLowerCase();
    const groups = new Map<string, AuditLogRecord[]>();

    for (const log of logs) {
      if (entity && log.entityType !== entity) continue;
      if (term && !`${log.action} ${log.actorLabel} ${log.hostelLabel ?? ""} ${log.entityType}`.toLowerCase().includes(term)) {
        continue;
      }
      const heading = dayHeading(log.createdAt);
      groups.set(heading, [...(groups.get(heading) ?? []), log]);
    }

    return Array.from(groups.entries());
  }, [entity, logs, query]);

  return (
    <div className="mx-auto max-w-[1100px] space-y-5">
      <PageHeader description="Every privileged platform action, newest first." icon={ScrollText} title="Audit Log" />
      <Message value={message} />

      <div className="flex flex-wrap items-center gap-2">
        <SearchField onChange={setQuery} placeholder="Search action, person or hostel" value={query} />
        <FilterButton active={entity ? 1 : 0} onClear={() => setEntity("")}>
          <FilterChoice
            label="What changed"
            onChange={setEntity}
            options={[{ label: "All", value: "" }, ...entities.map((item) => ({ label: humanize(item), value: item }))]}
            value={entity}
          />
        </FilterButton>
      </div>

      {days.length === 0 ? (
        <Panel>
          <EmptyState label="No audit entries yet." />
        </Panel>
      ) : null}

      {days.map(([heading, entries]) => (
        <section className="space-y-2" key={heading}>
          <h2 className="px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{heading}</h2>
          <div className="divide-y divide-border/70 rounded-2xl border border-border/70 bg-card">
            {entries.map((log) => (
              <div className="flex items-start gap-3 px-4 py-3" key={log.id}>
                <span className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full bg-role-team-soft text-role-team">
                  <ScrollText className="size-4" />
                </span>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="text-[13.5px] font-semibold text-foreground">
                    {humanize(log.action)}
                    <span className="ml-1.5 font-normal text-muted-foreground">by {log.actorLabel}</span>
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    <FactChip glyph="layers">{humanize(log.entityType)}</FactChip>
                    {log.hostelLabel ? <FactChip glyph="business">{log.hostelLabel}</FactChip> : null}
                  </div>
                  {Object.keys(log.metadata ?? {}).length > 0 ? (
                    <p className="truncate font-mono text-[11px] text-muted-foreground" title={metadataSummary(log.metadata)}>
                      {metadataSummary(log.metadata)}
                    </p>
                  ) : null}
                </div>
                <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground" title={formatTimestamp(log.createdAt)}>
                  {log.createdAt ? new Date(log.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : "-"}
                </span>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
});
