"use client";

import { ArrowLeft, Clock, MousePointerClick, Smartphone, Users } from "@/components/icons";
import { useState } from "react";

import { MetricCard, PortalPageHeader, SoftBadge, TabBar } from "@/app/_components/portal-dashboard-ui";
import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { usePortalResource } from "@/lib/portal-query";
import type { UsageAnalytics } from "@/modules/usage/usage.service";

import { Message } from "./core-portal-shared";

const RANGES = [7, 30, 90] as const;

/** `3h 12m`, `4m`, `20s` — time on a screen, read at a glance. */
function duration(ms: number) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function role(value: string) {
  return value.toLowerCase().replace(/_/g, " ");
}

/** One ranked list: a name, a bar against the top row, and its figures. */
function Ranked({
  empty,
  rows,
}: {
  empty: string;
  rows: { figures: string; key: string; label: string; onClick?: () => void; share: number; sub?: string }[];
}) {
  if (rows.length === 0) return <EmptyState label={empty} />;

  return (
    <div className="divide-y divide-border">
      {rows.map((row) => {
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate font-mono text-[13px] text-foreground">{row.label}</span>
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">{row.figures}</span>
            </div>
            {row.sub ? <p className="truncate text-xs text-muted-foreground">{row.sub}</p> : null}
            <div className="mt-1.5 h-1.5 rounded-full bg-muted">
              <div className="h-full rounded-full bg-primary" style={{ width: `${Math.max(2, row.share * 100)}%` }} />
            </div>
          </>
        );

        return row.onClick ? (
          <button
            className="block w-full py-2.5 text-left transition-colors hover:bg-muted/40"
            key={row.key}
            onClick={row.onClick}
            type="button"
          >
            {body}
          </button>
        ) : (
          <div className="py-2.5" key={row.key}>
            {body}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Superadmin → Analytics (FIELD_REVIEW H3): our own usage watcher. Which screens
 * hold people, what gets used, who opens the app — by role and hostel, or for
 * one person.
 */
export function PlatformUsagePageContent() {
  const [days, setDays] = useState<(typeof RANGES)[number]>(30);
  const [userId, setUserId] = useState<string | null>(null);
  const [tab, setTab] = useState<"screens" | "features" | "people" | "groups">("screens");
  const resource = usePortalResource<UsageAnalytics>(
    `/api/v1/platform/usage?days=${days}${userId ? `&userId=${userId}` : ""}`,
    { errorMessage: "Could not load usage." },
  );
  const data = resource.data;
  const top = (values: number[]) => Math.max(1, ...values);

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PortalPageHeader
        actions={
          <div className="flex gap-1.5">
            {RANGES.map((range) => (
              <Button
                key={range}
                onClick={() => setDays(range)}
                size="sm"
                variant={range === days ? "default" : "outline"}
              >
                {range} days
              </Button>
            ))}
          </div>
        }
        description="App opens, time on each screen and features used, from the app and the web portals."
        title={data?.user ? data.user.name : "Analytics"}
      />
      <Message value={resource.message} />

      {userId ? (
        <Button onClick={() => setUserId(null)} size="sm" variant="ghost">
          <ArrowLeft className="size-3.5" />
          Everyone
        </Button>
      ) : null}

      {resource.state === "loading" && !data ? <LoadingRows /> : null}

      {data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard icon={Users} label="People" value={data.totals.users} />
            <MetricCard icon={Smartphone} label="Opens" value={data.totals.opens} />
            <MetricCard icon={Clock} label="Time on screens" value={duration(data.totals.durationMs)} />
            <MetricCard icon={MousePointerClick} label="Features used" value={data.totals.uses} />
          </div>

          <TabBar
            onChange={(key) => setTab(key as typeof tab)}
            tabs={[
              { key: "screens", label: "Screens" },
              { key: "features", label: "Features" },
              ...(userId
                ? [{ key: "people", label: "Recent" }]
                : [
                    { key: "people", label: "People" },
                    { key: "groups", label: "Role & hostel" },
                  ]),
            ]}
            value={tab}
          />

          {tab === "screens" ? (
            <Panel title="Top screens by time">
              <Ranked
                empty="No screen time recorded yet."
                rows={data.screens.map((row) => ({
                  figures: `${duration(row.durationMs)} · ${row.views} views · ${row.users} people`,
                  key: row.screen,
                  label: row.screen,
                  share: row.durationMs / top(data.screens.map((item) => item.durationMs)),
                }))}
              />
            </Panel>
          ) : null}

          {tab === "features" ? (
            <Panel title="Features used">
              <Ranked
                empty="No feature use recorded yet."
                rows={data.features.map((row) => ({
                  figures: `${row.uses} uses · ${row.users} people`,
                  key: row.feature,
                  label: row.feature,
                  share: row.uses / top(data.features.map((item) => item.uses)),
                }))}
              />
            </Panel>
          ) : null}

          {tab === "people" && !userId ? (
            <Panel title="Opens per person">
              <Ranked
                empty="Nobody has opened the app since this went live."
                rows={data.users.map((row) => ({
                  figures: `${row.opens} opens · ${duration(row.durationMs)}`,
                  key: row.userId,
                  label: row.name,
                  onClick: () => {
                    setUserId(row.userId);
                    setTab("screens");
                  },
                  share: row.opens / top(data.users.map((item) => item.opens)),
                  sub: [role(row.role), row.hostelName, row.email, `last ${row.lastDay}`].filter(Boolean).join(" · "),
                }))}
              />
            </Panel>
          ) : null}

          {tab === "people" && userId ? (
            <Panel title="Recent activity">
              {data.recent.length === 0 ? <EmptyState label="Nothing in the last 90 days." /> : null}
              <div className="divide-y divide-border">
                {data.recent.map((event, index) => (
                  <div className="flex items-center justify-between gap-3 py-2 text-sm" key={`${event.at}-${index}`}>
                    <span className="flex min-w-0 items-center gap-2">
                      <SoftBadge tone={event.kind === "feature" ? "green" : "amber"}>{event.kind}</SoftBadge>
                      <span className="truncate font-mono text-[13px]">{event.screen || event.feature || "opened"}</span>
                    </span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {event.kind === "screen" ? `${duration(event.durationMs)} · ` : ""}
                      {event.client} · {new Date(event.at).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}

          {tab === "groups" ? (
            <div className="grid gap-5 lg:grid-cols-2">
              <Panel title="By role">
                <Ranked
                  empty="No usage yet."
                  rows={data.byRole.map((row) => ({
                    figures: `${row.users} people · ${row.opens} opens · ${duration(row.durationMs)}`,
                    key: row.role,
                    label: role(row.role),
                    share: row.opens / top(data.byRole.map((item) => item.opens)),
                  }))}
                />
              </Panel>
              <Panel title="By hostel">
                <Ranked
                  empty="No hostel usage yet."
                  rows={data.byHostel.map((row) => ({
                    figures: `${row.users} people · ${row.opens} opens · ${duration(row.durationMs)}`,
                    key: row.hostelId,
                    label: row.hostelName,
                    share: row.opens / top(data.byHostel.map((item) => item.opens)),
                  }))}
                />
              </Panel>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
