"use client";

import { MapPinned } from "@/components/icons";
import { memo, useCallback, useMemo, useState } from "react";

import { EmptyState, LoadingRows, Panel, StatusBadge } from "@/app/_components/shared-ui";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";
import { Message, PageHeader } from "./daily-operations-shared";

const ATTENDANCE_ENDPOINT = "/api/v1/hostel-admin/attendance";
const ALERTS_ENDPOINT = "/api/v1/hostel-admin/attendance/alerts";

type Zone = "INSIDE" | "NEARBY" | "OUTSIDE" | "UNKNOWN";

type AttendanceRow = {
  resident: { fullName: string; id: string; roomType: string };
  zone: Zone;
};

type AttendanceAlert = {
  consecutiveDays: number;
  id: string;
  lastSeenAt?: string;
  residentName: string;
  resolutionNote: string;
  status: string;
};

/** Zone → colour. Matches the calendar key in the resident view. */
const ZONE_STYLES: Record<Zone, string> = {
  INSIDE: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  NEARBY: "bg-amber-500/10 text-amber-700 dark:text-amber-400",
  OUTSIDE: "bg-rose-500/10 text-rose-700 dark:text-rose-400",
  UNKNOWN: "bg-muted text-muted-foreground",
};

const ZONE_ORDER: Zone[] = ["INSIDE", "NEARBY", "OUTSIDE", "UNKNOWN"];

/**
 * A resident's last 60 days as a grid — the same day-level view the resident
 * has of themselves, so an admin checking an absence alert reads the same
 * picture. Days with no reading are blank, not "outside": no data is not
 * evidence of absence.
 */
function AttendanceCalendar({ residentId }: { residentId: string }) {
  const resource = usePortalResource<{ history: Array<{ day: string; zone: Zone }> }>(
    `${ATTENDANCE_ENDPOINT}?residentId=${residentId}`,
    { errorMessage: "Could not load this resident's history." },
  );

  const zoneByDay = useMemo(() => {
    const map = new Map<string, Zone>();

    for (const entry of resource.data?.history ?? []) {
      map.set(entry.day.slice(0, 10), entry.zone);
    }

    return map;
  }, [resource.data]);

  const days = useMemo(() => {
    const today = new Date();

    return Array.from({ length: 60 }, (_, index) => {
      const date = new Date(today);

      date.setUTCDate(date.getUTCDate() - (59 - index));

      return date.toISOString().slice(0, 10);
    });
  }, []);

  if (resource.state === "loading") {
    return <LoadingRows />;
  }

  if (resource.state === "error") {
    return <EmptyState label="This resident's history could not be loaded." />;
  }

  if (zoneByDay.size === 0) {
    return <EmptyState label="No attendance readings for this resident yet." />;
  }

  return (
    <div className="mt-3 rounded-lg border border-border p-3">
      {/* 60 cells: 6 rows on mobile, 5 on wider screens. */}
      <div className="grid grid-cols-10 gap-1 sm:grid-cols-12">
        {days.map((day) => {
          const zone = zoneByDay.get(day);

          return (
            <span
              className={cn(
                "aspect-square rounded-sm border border-border/60",
                zone ? ZONE_STYLES[zone] : "bg-transparent",
              )}
              key={day}
              title={`${day}: ${zone ?? "no reading"}`}
            />
          );
        })}
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {ZONE_ORDER.map((zone) => (
          <div className="flex items-center gap-1.5" key={zone}>
            <span className={cn("size-3 rounded-sm", ZONE_STYLES[zone])} />
            <dt className="sr-only">Legend</dt>
            <dd>{zone}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export const HostelAdminAttendancePageContent = memo(
  function HostelAdminAttendancePageContent() {
    const [actionMessage, setActionMessage] = useState("");
    const [selectedResidentId, setSelectedResidentId] = useState("");
    const invalidate = useInvalidateResources();
    const attendance = usePortalResource<{
      summary: Record<string, number>;
      today: AttendanceRow[];
    }>(ATTENDANCE_ENDPOINT, { errorMessage: "Could not load attendance." });
    const alerts = usePortalResource<{ alerts: AttendanceAlert[] }>(ALERTS_ENDPOINT, {
      errorMessage: "Could not load attendance alerts.",
    });

    const rows = useMemo(() => attendance.data?.today ?? [], [attendance.data]);
    const summary = attendance.data?.summary ?? {};
    const openAlerts = useMemo(
      () => (alerts.data?.alerts ?? []).filter((alert) => alert.status === "OPEN"),
      [alerts.data],
    );

    const override = useCallback(
      async (residentId: string) => {
        const zone = window
          .prompt("Set zone for today (INSIDE, NEARBY, OUTSIDE, UNKNOWN)")
          ?.trim()
          .toUpperCase();

        if (!zone || !ZONE_ORDER.includes(zone as Zone)) {
          return;
        }

        // The reason is not optional — an override without one is a silent edit
        // of a safety record.
        const reason = window.prompt("Why are you overriding this? (required)")?.trim();

        if (!reason) {
          setActionMessage("An override needs a reason.");

          return;
        }

        try {
          await browserApi(`${ATTENDANCE_ENDPOINT}/${residentId}/override`, {
            body: JSON.stringify({
              day: new Date().toISOString(),
              reason,
              zone,
            }),
            method: "PATCH",
          });
          setActionMessage("Attendance overridden.");
          invalidate(ATTENDANCE_ENDPOINT);
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not override attendance.",
          );
        }
      },
      [invalidate],
    );

    const resolveAlert = useCallback(
      async (alertId: string) => {
        const note = window.prompt("Resolution note (optional)")?.trim();

        try {
          await browserApi(`${ALERTS_ENDPOINT}/${alertId}/resolve`, {
            body: JSON.stringify(note ? { note } : {}),
            method: "PATCH",
          });
          setActionMessage("Alert resolved.");
          invalidate(ALERTS_ENDPOINT);
        } catch (error) {
          setActionMessage(
            error instanceof Error ? error.message : "Could not resolve the alert.",
          );
        }
      },
      [invalidate],
    );

    return (
      <div className="mx-auto max-w-[1448px] space-y-6">
        <PageHeader
          description="Where residents are today, by zone. Exact locations are never stored."
          icon={MapPinned}
          title="Attendance"
        />
        <Message value={actionMessage || attendance.message} />

        <div className="grid gap-3 sm:grid-cols-4">
          {ZONE_ORDER.map((zone) => (
            <div className="rounded-lg border border-border bg-surface p-4" key={zone}>
              <p className="text-xs font-semibold uppercase text-muted-foreground">
                {zone}
              </p>
              <p className="mt-1 text-3xl font-extrabold text-foreground">
                {summary[zone] ?? 0}
              </p>
            </div>
          ))}
        </div>

        <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
          <Panel title="Today">
            {attendance.state === "loading" ? <LoadingRows /> : null}
            {attendance.state === "ready" && rows.length === 0 ? (
              <EmptyState label="No active residents to track." />
            ) : null}
            <div className="space-y-2">
              {rows.map((row) => (
                <div
                  className="rounded-lg border border-border p-3"
                  key={row.resident.id}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold text-foreground">
                        {row.resident.fullName}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {row.resident.roomType}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "rounded-full px-2.5 py-1 text-xs font-bold",
                          ZONE_STYLES[row.zone],
                        )}
                      >
                        {row.zone}
                      </span>
                      <button
                        aria-pressed={selectedResidentId === row.resident.id}
                        className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground"
                        onClick={() =>
                          setSelectedResidentId((current) =>
                            current === row.resident.id ? "" : row.resident.id,
                          )
                        }
                        type="button"
                      >
                        {selectedResidentId === row.resident.id
                          ? "Hide history"
                          : "History"}
                      </button>
                      <button
                        className="rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground"
                        onClick={() => void override(row.resident.id)}
                        type="button"
                      >
                        Override
                      </button>
                    </div>
                  </div>
                  {selectedResidentId === row.resident.id ? (
                    <AttendanceCalendar residentId={row.resident.id} />
                  ) : null}
                </div>
              ))}
            </div>
          </Panel>

          <Panel title="Absence Alerts">
            {alerts.state === "loading" ? <LoadingRows /> : null}
            {alerts.state === "ready" && openAlerts.length === 0 ? (
              <EmptyState label="No open absence alerts." />
            ) : null}
            <div className="space-y-3">
              {openAlerts.map((alert) => (
                <div className="rounded-lg border border-border p-4" key={alert.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold text-foreground">
                        {alert.residentName}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Away {alert.consecutiveDays} consecutive days
                      </p>
                    </div>
                    <StatusBadge>{alert.status}</StatusBadge>
                  </div>
                  <button
                    className="mt-3 rounded-md bg-role-admin px-3 py-2 text-sm font-semibold text-white"
                    onClick={() => void resolveAlert(alert.id)}
                    type="button"
                  >
                    Resolve
                  </button>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    );
  },
);
