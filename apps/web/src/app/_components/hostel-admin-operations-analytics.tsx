"use client";

import React from "react";

import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { usePortalResource } from "@/lib/portal-query";
import { StatTile } from "./report-widgets";

type FoodAnalytics = {
  byDevice: Array<{ announcements: number; device: string; lastAnnouncedAt: string }>;
  byMeal: Array<{
    announcements: number;
    averageDelayMinutes: number | null;
    averageReadyMinutes: number | null;
    lateCount: number;
    mealType: string;
    notified: number;
    onTimeCount: number;
    scheduledTiming: string | null;
  }>;
  summary: {
    averageDelayMinutes: number | null;
    lateAnnouncements: number;
    onTimeAnnouncements: number;
    totalAnnouncements: number;
    windowDays: number;
  };
};

type AttendanceAnalytics = {
  frequentlyAbsent: Array<{
    attendanceRate: number;
    name: string;
    outside: number;
    residentId: string;
    roomType: string;
    total: number;
    unknown: number;
  }>;
  summary: {
    averageAttendanceRate: number;
    pings: number;
    residentsTracked: number;
    windowDays: number;
    zones: { inside: number; nearby: number; outside: number; unknown: number };
  };
};

const FOOD_ENDPOINT = "/api/v1/hostel-admin/reports/food";
const ATTENDANCE_ENDPOINT = "/api/v1/hostel-admin/reports/attendance";

/** 1110 → "18:30". Minutes since midnight is how the service reports times. */
function clockTime(minutes: number | null) {
  if (minutes === null) {
    return "—";
  }

  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;

  return `${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`;
}

function delayLabel(minutes: number | null) {
  if (minutes === null) {
    return "No timing set";
  }

  if (minutes === 0) {
    return "On time";
  }

  return minutes > 0 ? `${minutes} min late` : `${Math.abs(minutes)} min early`;
}

function percent(value: number) {
  return `${Math.round(value * 100)}%`;
}

export const HostelAdminFoodAnalyticsPanel = React.memo(
  function HostelAdminFoodAnalyticsPanel() {
    const resource = usePortalResource<FoodAnalytics>(FOOD_ENDPOINT, {
      errorMessage: "Could not load food analytics.",
    });
    const data = resource.data ?? null;

    return (
      <Panel title="Food service timing">
        {resource.state === "loading" ? <LoadingRows /> : null}
        {resource.state === "error" ? (
          <EmptyState label="Food analytics could not be loaded." />
        ) : null}

        {data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile
                hint={`Last ${data.summary.windowDays} days`}
                label="Announcements"
                value={data.summary.totalAnnouncements}
              />
              <StatTile
                hint="Within 15 minutes of the published time"
                label="On time"
                tone="good"
                value={data.summary.onTimeAnnouncements}
              />
              <StatTile
                hint="More than 15 minutes late"
                label="Late"
                tone={data.summary.lateAnnouncements > 0 ? "warn" : "default"}
                value={data.summary.lateAnnouncements}
              />
              <StatTile
                hint="Across meals with a published timing"
                label="Average delay"
                value={delayLabel(data.summary.averageDelayMinutes)}
              />
            </div>

            <div className="mt-4 overflow-x-auto">
              {data.summary.totalAnnouncements === 0 ? (
                <EmptyState glyph="restaurant" label="No food-ready announcements in this window yet." />
              ) : (
                <table className="w-full min-w-[560px] text-sm">
                  <caption className="sr-only">
                    Food-ready timing per meal against the published routine
                  </caption>
                  <thead>
                    <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                      <th className="py-2 pr-3 font-medium" scope="col">
                        Meal
                      </th>
                      <th className="py-2 pr-3 font-medium" scope="col">
                        Scheduled
                      </th>
                      <th className="py-2 pr-3 font-medium" scope="col">
                        Avg ready
                      </th>
                      <th className="py-2 pr-3 font-medium" scope="col">
                        Avg delay
                      </th>
                      <th className="py-2 text-right font-medium" scope="col">
                        Announcements
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byMeal.map((meal) => (
                      <tr className="border-b border-border/60" key={meal.mealType}>
                        <th
                          className="py-2 pr-3 text-left font-medium text-foreground"
                          scope="row"
                        >
                          {meal.mealType}
                        </th>
                        <td className="py-2 pr-3">{meal.scheduledTiming ?? "—"}</td>
                        <td className="py-2 pr-3 tabular-nums">
                          {clockTime(meal.averageReadyMinutes)}
                        </td>
                        <td className="py-2 pr-3">
                          {delayLabel(meal.averageDelayMinutes)}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {meal.announcements}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {data.byDevice.length > 0 ? (
              <div className="mt-4 border-t border-border pt-3">
                {/* Cook credentials are shared, so this is per device, not per person. */}
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  By kitchen device
                </p>
                <ul className="mt-2 space-y-1 text-sm">
                  {data.byDevice.map((entry) => (
                    <li className="flex justify-between gap-3" key={entry.device}>
                      <span className="truncate text-muted-foreground">
                        {entry.device}
                      </span>
                      <span className="tabular-nums text-foreground">
                        {entry.announcements}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : null}
      </Panel>
    );
  },
);

export const HostelAdminAttendanceAnalyticsPanel = React.memo(
  function HostelAdminAttendanceAnalyticsPanel() {
    const resource = usePortalResource<AttendanceAnalytics>(ATTENDANCE_ENDPOINT, {
      errorMessage: "Could not load attendance analytics.",
    });
    const data = resource.data ?? null;

    return (
      <Panel title="Attendance patterns">
        {resource.state === "loading" ? <LoadingRows /> : null}
        {resource.state === "error" ? (
          <EmptyState label="Attendance analytics could not be loaded." />
        ) : null}

        {data ? (
          <>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <StatTile
                hint="Inside or nearby, across all readings"
                label="Attendance rate"
                tone={data.summary.averageAttendanceRate >= 0.7 ? "good" : "warn"}
                value={percent(data.summary.averageAttendanceRate)}
              />
              <StatTile
                hint={`Last ${data.summary.windowDays} days`}
                label="Residents tracked"
                value={data.summary.residentsTracked}
              />
              <StatTile
                hint="Away from the hostel"
                label="Outside readings"
                value={data.summary.zones.outside}
              />
              <StatTile
                hint="Phone off or no signal"
                label="Unknown readings"
                value={data.summary.zones.unknown}
              />
            </div>

            <div className="mt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Frequently absent
              </p>
              {data.frequentlyAbsent.length === 0 ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  Nobody is below half attendance in this window.
                </p>
              ) : (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full min-w-[460px] text-sm">
                    <caption className="sr-only">Residents below 50% attendance</caption>
                    <thead>
                      <tr className="border-b border-border text-left text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="py-2 pr-3 font-medium" scope="col">
                          Resident
                        </th>
                        <th className="py-2 pr-3 font-medium" scope="col">
                          Room type
                        </th>
                        <th className="py-2 pr-3 text-right font-medium" scope="col">
                          Readings
                        </th>
                        <th className="py-2 text-right font-medium" scope="col">
                          Attendance
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.frequentlyAbsent.map((entry) => (
                        <tr className="border-b border-border/60" key={entry.residentId}>
                          <th
                            className="py-2 pr-3 text-left font-medium text-foreground"
                            scope="row"
                          >
                            {entry.name}
                          </th>
                          <td className="py-2 pr-3 text-muted-foreground">
                            {entry.roomType || "—"}
                          </td>
                          <td className="py-2 pr-3 text-right tabular-nums">
                            {entry.total}
                          </td>
                          <td className="py-2 text-right tabular-nums">
                            {percent(entry.attendanceRate)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        ) : null}
      </Panel>
    );
  },
);
