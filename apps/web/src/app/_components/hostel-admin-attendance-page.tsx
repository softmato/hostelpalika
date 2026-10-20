"use client";

import { HelpCircle, Home, MapPin, MapPinned, Navigation } from "@/components/icons";
import { memo, useCallback, useMemo, useState } from "react";

import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { Chip, RowMark, ShareBar, type ChipTone } from "@/app/_components/hostel-admin-page-ui";
import { FilterButton, FilterChoice } from "@/components/filter-panel";
import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";
import { Message, PageHeader } from "./daily-operations-shared";
import { InitialsAvatar, MetricCard, SearchField } from "./portal-dashboard-ui";

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

/**
 * Zone → calendar cell. Brand for in or near, plain for out: being outside is
 * ordinary life (docs/DESIGN.md), not a warning.
 */
const ZONE_STYLES: Record<Zone, string> = {
  INSIDE: "bg-brand-teal/80",
  NEARBY: "bg-brand-teal/35",
  OUTSIDE: "bg-foreground/25",
  UNKNOWN: "bg-muted",
};

const ZONE_TONE: Record<Zone, ChipTone> = {
  INSIDE: "brand",
  NEARBY: "brand",
  OUTSIDE: "neutral",
  UNKNOWN: "neutral",
};

function zoneLabel(zone: Zone) {
  return zone.charAt(0) + zone.slice(1).toLowerCase();
}

const ZONE_ORDER: Zone[] = ["INSIDE", "NEARBY", "OUTSIDE", "UNKNOWN"];
const ZONE_ICONS = { INSIDE: Home, NEARBY: MapPin, OUTSIDE: Navigation, UNKNOWN: HelpCircle };

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
    <div className="mt-3 rounded-xl bg-muted/40 p-3">
      {/* 60 cells: 6 rows on mobile, 5 on wider screens. */}
      <div className="grid grid-cols-10 gap-1 sm:grid-cols-12">
        {days.map((day) => {
          const zone = zoneByDay.get(day);

          return (
            <span
              className={cn(
                "aspect-square rounded-[5px] border border-border/50",
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
            <span className={cn("size-3 rounded-[4px]", ZONE_STYLES[zone])} />
            <dt className="sr-only">Legend</dt>
            <dd>{zoneLabel(zone)}</dd>
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
    const [search, setSearch] = useState("");
    const [zoneFilter, setZoneFilter] = useState<Zone | "ALL">("ALL");
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
    const shown = useMemo(() => {
      const query = search.trim().toLowerCase();

      return rows.filter(
        (row) =>
          (zoneFilter === "ALL" || row.zone === zoneFilter) &&
          (!query || `${row.resident.fullName} ${row.resident.roomType}`.toLowerCase().includes(query)),
      );
    }, [rows, search, zoneFilter]);
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
      <div className="mx-auto max-w-[1448px] space-y-5">
        <PageHeader
          description="Where residents are today, by zone. No location is stored."
          icon={MapPinned}
          title="Attendance"
        />
        <Message value={actionMessage || attendance.message} />

        <div className="grid gap-3 sm:grid-cols-4">
          {ZONE_ORDER.map((zone) => (
            <MetricCard
              icon={ZONE_ICONS[zone]}
              key={zone}
              label={zone.toLowerCase()}
              tone={zone === "INSIDE" || zone === "NEARBY" ? "teal" : "slate"}
              value={summary[zone] ?? 0}
            />
          ))}
        </div>

        {rows.length > 0 ? (
          <div className="rounded-2xl border border-border/70 bg-card px-4 py-3">
            <ShareBar label="inside today" total={rows.length} value={summary.INSIDE ?? 0} />
          </div>
        ) : null}

        <div className="grid gap-5 xl:grid-cols-[1fr_380px]">
          <Panel title="Today">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <SearchField onChange={setSearch} placeholder="Search name or room type" size="lg" value={search} />
              <FilterButton active={zoneFilter === "ALL" ? 0 : 1} onClear={() => setZoneFilter("ALL")}>
                <FilterChoice<Zone | "ALL">
                  label="Zone"
                  onChange={setZoneFilter}
                  options={[
                    { label: "All", value: "ALL" },
                    ...ZONE_ORDER.map((zone) => ({ label: zoneLabel(zone), value: zone })),
                  ]}
                  value={zoneFilter}
                />
              </FilterButton>
            </div>
            {attendance.state === "loading" ? <LoadingRows /> : null}
            {attendance.state === "ready" && shown.length === 0 ? (
              <EmptyState label={rows.length === 0 ? "No active residents to track." : "Nothing matches."} />
            ) : null}
            <div className="divide-y divide-border/60">
              {shown.map((row) => (
                <div className="py-2.5" key={row.resident.id}>
                  <div className="flex flex-wrap items-center gap-3">
                    <InitialsAvatar name={row.resident.fullName} size="sm" tone="admin" />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13.5px] font-semibold text-foreground">
                        {row.resident.fullName}
                      </p>
                      <p className="text-[12px] text-muted-foreground">
                        {row.resident.roomType}
                      </p>
                    </div>
                    <Chip tone={ZONE_TONE[row.zone]}>{zoneLabel(row.zone)}</Chip>
                    <div className="flex items-center gap-1">
                      <Button
                        aria-pressed={selectedResidentId === row.resident.id}
                        onClick={() =>
                          setSelectedResidentId((current) =>
                            current === row.resident.id ? "" : row.resident.id,
                          )
                        }
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        {selectedResidentId === row.resident.id
                          ? "Hide history"
                          : "History"}
                      </Button>
                      <Button
                        onClick={() => void override(row.resident.id)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        Override
                      </Button>
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
            <div className="divide-y divide-border/60">
              {openAlerts.map((alert) => (
                <div className="flex items-center gap-3 py-2.5" key={alert.id}>
                  <RowMark glyph="alarm" tone="warn" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13.5px] font-semibold text-foreground">
                      {alert.residentName}
                    </p>
                    <p className="text-[12px] text-muted-foreground">
                      Away {alert.consecutiveDays} days in a row
                    </p>
                  </div>
                  <Button
                    className="bg-brand-teal text-white hover:bg-brand-teal/90"
                    onClick={() => void resolveAlert(alert.id)}
                    size="sm"
                    type="button"
                  >
                    Resolve
                  </Button>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>
    );
  },
);
