"use client";

import { formatHostelDateTime } from "@hostel/shared/calendar/bs";

import { AlertTriangle, CheckCircle2, Clock, Siren } from "@/components/icons";
import { memo, useCallback, useMemo, useState } from "react";

import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { type SOSAlert, Message, PageHeader } from "./daily-operations-shared";
import { EmptyState, Panel } from "@/app/_components/shared-ui";
import { Chip, RowMark, type ChipTone } from "@/app/_components/hostel-admin-page-ui";
import { MetricCard } from "@/app/_components/portal-dashboard-ui";
import { Button } from "@/components/ui/button";

/** Only an alert nobody has answered is red; the rest is history. */
const STATUS_TONE: Record<SOSAlert["status"], ChipTone> = {
  ACKNOWLEDGED: "warn",
  ACTIVE: "bad",
  FALSE_ALARM: "neutral",
  RESOLVED: "brand",
};

function words(value: string) {
  const text = value.replaceAll("_", " ").toLowerCase();

  return text.charAt(0).toUpperCase() + text.slice(1);
}

export const HostelAdminSOSAlertsPage = memo(function HostelAdminSOSAlertsPage() {
  const [actionMessage, setActionMessage] = useState("");
  const invalidate = useInvalidateResources();
  const alertsResource = usePortalResource<{ alerts: SOSAlert[] }>(
    hostelAdminEndpoints.sosAlerts,
    { errorMessage: "Could not load SOS alerts." },
  );

  const alerts = useMemo(() => alertsResource.data?.alerts ?? [], [alertsResource.data]);
  const message = actionMessage || alertsResource.message;
  const count = (status: SOSAlert["status"]) => alerts.filter((alert) => alert.status === status).length;

  const update = useCallback(
    async (alertId: string, status: string) => {
      try {
        await browserApi(`${hostelAdminEndpoints.sosAlerts}/${alertId}/status`, {
          body: JSON.stringify({ status }),
          method: "PATCH",
        });
        setActionMessage("SOS alert updated.");
        invalidate(hostelAdminEndpoints.sosAlerts);
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not update SOS alert.",
        );
      }
    },
    [invalidate],
  );

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PageHeader
        description="Emergency alerts raised by residents."
        icon={Siren}
        title="SOS Alerts"
      />
      <Message value={message} />

      <div className="grid gap-3 sm:grid-cols-3">
        <MetricCard icon={Siren} label="Active" tone={count("ACTIVE") > 0 ? "rose" : "slate"} value={count("ACTIVE")} />
        <MetricCard icon={Clock} label="Acknowledged" tone="amber" value={count("ACKNOWLEDGED")} />
        <MetricCard icon={CheckCircle2} label="Resolved" value={count("RESOLVED")} />
      </div>

      <Panel>
        {alerts.length === 0 ? <EmptyState label="No SOS alerts." /> : null}
        <div className="divide-y divide-border/60">
          {alerts.map((alert) => (
            <div className="flex flex-wrap items-center gap-3 py-3" key={alert.id}>
              <RowMark glyph={alert.status === "ACTIVE" ? "siren" : "shield"} tone={alert.status === "ACTIVE" ? "bad" : "neutral"} />
              <div className="min-w-0 flex-1">
                <p className="text-[13.5px] font-semibold text-foreground">Resident {alert.residentId}</p>
                <p className="text-[13px] text-muted-foreground">{alert.message}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <Chip tone={STATUS_TONE[alert.status]}>{words(alert.status)}</Chip>
                  {alert.createdAt ? <Chip glyph="time">{formatHostelDateTime(alert.createdAt)}</Chip> : null}
                  {alert.guardianAlertEnabled ? <Chip glyph="people">Guardian told</Chip> : null}
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {["ACKNOWLEDGED", "RESOLVED", "FALSE_ALARM"].map((item) => (
                  <Button
                    key={item}
                    onClick={() => void update(alert.id, item)}
                    size="sm"
                    type="button"
                    variant={item === "RESOLVED" ? "default" : "outline"}
                    className={item === "RESOLVED" ? "bg-brand-teal text-white hover:bg-brand-teal/90" : undefined}
                  >
                    {item === "FALSE_ALARM" ? <AlertTriangle className="size-3.5" /> : null}
                    {words(item)}
                  </Button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
});
