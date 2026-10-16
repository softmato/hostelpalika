"use client";

import { ScrollText } from "@/components/icons";
import { memo } from "react";

import { EmptyState, Panel } from "@/app/_components/shared-ui";
import { platformEndpoints } from "@/lib/platform-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { Message, PageHeader } from "./core-portal-shared";

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
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString();
}

function metadataSummary(metadata: Record<string, unknown>) {
  const entries = Object.entries(metadata ?? {});
  if (entries.length === 0) {
    return "-";
  }

  return entries.map(([key, value]) => `${key}: ${String(value)}`).join(", ");
}

export const PlatformAuditLogsPageContent = memo(function PlatformAuditLogsPageContent() {
  const logsResource = usePortalResource<{ logs: AuditLogRecord[] }>(
    platformEndpoints.auditLogs,
    { errorMessage: "Could not load audit logs." },
  );

  const logs = logsResource.data?.logs ?? [];
  const message = logsResource.message;

  return (
    <div className="mx-auto max-w-[1448px] space-y-6">
      <PageHeader
        description="Read-only trail of privileged platform actions (newest first)."
        icon={ScrollText}
        title="Audit Log"
      />
      <Message value={message} />
      <Panel>
        {logs.length === 0 ? <EmptyState label="No audit entries yet." /> : null}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="py-2">When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Entity</th>
                <th>Hostel</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {logs.map((log) => (
                <tr key={log.id}>
                  <td className="whitespace-nowrap py-3">
                    {formatTimestamp(log.createdAt)}
                  </td>
                  <td>{log.actorLabel}</td>
                  <td className="font-medium text-foreground">{log.action}</td>
                  <td>
                    {log.entityType}
                    <p className="text-xs text-muted-foreground">{log.entityId}</p>
                  </td>
                  <td>{log.hostelLabel ?? "-"}</td>
                  <td className="max-w-[280px] truncate text-xs text-muted-foreground">
                    {metadataSummary(log.metadata)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
});
