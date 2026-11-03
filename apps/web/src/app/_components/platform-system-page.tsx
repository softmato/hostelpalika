"use client";

import { Activity, Clock, Users } from "@/components/icons";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { useAction } from "@/app/_components/booking-admin-ui";
import { PlatformUsagePageContent } from "@/app/_components/platform-usage-page";
import { MetricCard, PortalPageHeader, SoftBadge, TabBar, type SoftTone } from "@/app/_components/portal-dashboard-ui";
import { EmptyState, LoadingRows, Panel } from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { usePortalResource } from "@/lib/portal-query";

import { Message } from "./core-portal-shared";

/**
 * Superadmin → System (server/docs/PHASES.md Phase 7): the Go server's own
 * logs, the process, who was active, and the usage page. Every route here is
 * Go-only, read through `API_URL`, so it answers once the API cuts over.
 */

export type SystemTab = "logs" | "process" | "active-users" | "analytics";

const TABS: { href: string; key: SystemTab; label: string }[] = [
  { href: "/platform/logs", key: "logs", label: "Logs" },
  { href: "/platform/system/process", key: "process", label: "Process" },
  { href: "/platform/system/active-users", key: "active-users", label: "Active users" },
  { href: "/platform/analytics", key: "analytics", label: "Analytics" },
];

const LEVELS = ["debug", "info", "warn", "error"] as const;
const LEVEL_TONE: Record<string, SoftTone> = { debug: "slate", error: "rose", info: "blue", warn: "amber" };

type LogEntry = {
  at: string;
  attrs?: Record<string, unknown>;
  category: string;
  durationMs?: number;
  hostelId?: string;
  id: string;
  level: string;
  message: string;
  method?: string;
  requestId?: string;
  route?: string;
  status?: number;
  userId?: string;
};

type Health = {
  cacheHitRate: number;
  errorRate: number;
  mongoCheckoutFailures: number;
  mongoPoolInUse: number;
  p95Seconds: number;
  rateLimited: number;
  requests: number;
  requestsPerMinute: number;
  uptimeSeconds: number;
};

const pct = (value: number) => `${(value * 100).toFixed(value < 0.01 && value > 0 ? 2 : 1)}%`;
const when = (iso: string) => new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "medium" });

function uptime(seconds: number) {
  const h = Math.floor(seconds / 3600);
  return h >= 24 ? `${Math.floor(h / 24)}d ${h % 24}h` : `${h}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function bytes(n: number) {
  return n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : `${(n / (1 << 20)).toFixed(1)} MB`;
}

export function PlatformSystemPage({ tab }: { tab: SystemTab }) {
  const router = useRouter();

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      {tab === "analytics" ? null : <PortalPageHeader title="System" />}
      <TabBar
        onChange={(key) => router.push(TABS.find((t) => t.key === key)!.href)}
        tabs={TABS.map(({ key, label }) => ({ key, label }))}
        value={tab}
      />
      {tab === "logs" ? <LogsTab /> : null}
      {tab === "process" ? <ProcessTab /> : null}
      {tab === "active-users" ? <ActiveUsersTab /> : null}
      {tab === "analytics" ? <PlatformUsagePageContent /> : null}
    </div>
  );
}

/* ── Logs ── */

function HealthStrip() {
  const health = usePortalResource<{ health: Health }>("/api/v1/platform/logs/health").data?.health;

  if (!health) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-3 xl:grid-cols-6">
      <MetricCard icon={Activity} label="Requests / min" note={`up ${uptime(health.uptimeSeconds)}`} value={health.requestsPerMinute.toFixed(1)} />
      <MetricCard icon={Clock} label="p95" value={`${Math.round(health.p95Seconds * 1000)} ms`} />
      <MetricCard label="Error rate" tone={health.errorRate > 0.01 ? "rose" : "teal"} value={pct(health.errorRate)} />
      <MetricCard label="Mongo pool in use" note={health.mongoCheckoutFailures ? `${health.mongoCheckoutFailures} waits failed` : undefined} value={health.mongoPoolInUse} />
      <MetricCard label="Cache hit rate" value={pct(health.cacheHitRate)} />
      <MetricCard label="Rate-limit refusals" value={health.rateLimited} />
    </div>
  );
}

function LevelControls({ categories }: { categories: string[] }) {
  const config = usePortalResource<{ config: { logs?: { levels: Record<string, string> } } }>("/api/v1/platform/site-config");
  const { busy, run } = useAction(["/api/v1/platform/site-config"]);
  const levels = config.data?.config.logs?.levels;

  if (!levels) return null;

  return (
    <Panel title="Stored level per category">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        {categories.map((category) => (
          <label className="flex items-center justify-between gap-2 text-sm" key={category}>
            <span className="font-mono">{category}</span>
            <select
              className="rounded-md border border-border bg-background px-2 py-1 text-sm"
              disabled={busy !== null}
              onChange={(event) =>
                void run(
                  "levels",
                  "/api/v1/platform/site-config/logs",
                  { levels: { ...levels, [category]: event.target.value } },
                  `${category} now logs at ${event.target.value}.`,
                  "PUT",
                )
              }
              value={levels[category] ?? "default"}
            >
              {["default", ...LEVELS].map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
    </Panel>
  );
}

function LogsTab() {
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [cursor, setCursor] = useState<string[]>([]);
  const [open, setOpen] = useState<LogEntry | null>(null);
  const query = new URLSearchParams({ ...filters, ...(cursor.length ? { cursor: cursor[cursor.length - 1] } : {}) });
  const resource = usePortalResource<{ entries: LogEntry[]; nextCursor: string | null }>(`/api/v1/platform/logs?${query}`);
  const summary = usePortalResource<{ categories: string[]; counts: { category: string; count: number; level: string }[]; dropped: number }>(
    "/api/v1/platform/logs/summary",
  ).data;
  const set = (key: string, value: string) => {
    setCursor([]);
    setFilters((current) => {
      const next = { ...current };
      if (value && current[key] !== value) next[key] = value;
      else delete next[key];
      return next;
    });
  };
  const countOf = (pick: (row: { category: string; level: string }) => boolean) =>
    summary?.counts.filter(pick).reduce((sum, row) => sum + row.count, 0) ?? 0;

  return (
    <div className="space-y-4">
      <HealthStrip />
      <Message value={resource.message} />

      <div className="flex flex-wrap gap-1.5">
        {LEVELS.map((level) => (
          <Button key={level} onClick={() => set("level", level)} size="sm" variant={filters.level === level ? "default" : "outline"}>
            {level} {summary ? <span className="tabular-nums opacity-70">{countOf((row) => row.level === level)}</span> : null}
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-1.5">
        {(summary?.categories ?? []).map((category) => (
          <Button key={category} onClick={() => set("category", category)} size="sm" variant={filters.category === category ? "default" : "outline"}>
            {category} <span className="tabular-nums opacity-70">{countOf((row) => row.category === category)}</span>
          </Button>
        ))}
      </div>
      <form
        className="grid gap-2 sm:grid-cols-3 xl:grid-cols-6"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          setCursor([]);
          setFilters((current) => {
            const next: Record<string, string> = { ...(current.level ? { level: current.level } : {}), ...(current.category ? { category: current.category } : {}) };
            for (const key of ["q", "route", "requestId", "userId", "hostelId", "from", "to"]) {
              const raw = String(form.get(key) ?? "").trim();
              if (raw) next[key] = key === "from" || key === "to" ? new Date(raw).toISOString() : raw;
            }
            return next;
          });
        }}
      >
        <input className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" defaultValue={filters.q} name="q" placeholder="Text" />
        <input className="rounded-md border border-border bg-background px-2 py-1.5 text-sm" defaultValue={filters.route} name="route" placeholder="Route" />
        <input className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm" key={filters.requestId} defaultValue={filters.requestId} name="requestId" placeholder="Request id" />
        <input className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm" defaultValue={filters.userId} name="userId" placeholder="User id" />
        <input className="rounded-md border border-border bg-background px-2 py-1.5 font-mono text-sm" defaultValue={filters.hostelId} name="hostelId" placeholder="Hostel id" />
        <div className="flex gap-2">
          <input aria-label="From" className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm" name="from" type="datetime-local" />
          <Button size="sm" type="submit">
            Apply
          </Button>
        </div>
      </form>

      {resource.state === "loading" && !resource.data ? <LoadingRows /> : null}
      {resource.data && resource.data.entries.length === 0 ? <EmptyState label="No log lines match." /> : null}
      {resource.data && resource.data.entries.length > 0 ? (
        <div className="divide-y divide-border rounded-xl border border-border">
          {resource.data.entries.map((entry) => (
            <button className="block w-full px-3 py-2 text-left hover:bg-muted/40" key={entry.id} onClick={() => setOpen(open?.id === entry.id ? null : entry)} type="button">
              <div className="flex items-center gap-2 text-sm">
                <SoftBadge tone={LEVEL_TONE[entry.level]}>{entry.level}</SoftBadge>
                <span className="font-mono text-xs text-muted-foreground">{entry.category}</span>
                <span className="min-w-0 flex-1 truncate">{entry.message}</span>
                {entry.status ? <span className="font-mono text-xs tabular-nums">{entry.status}</span> : null}
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{when(entry.at)}</span>
              </div>
              {open?.id === entry.id ? (
                <div className="mt-2 space-y-2">
                  <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(entry, null, 2)}</pre>
                  {entry.requestId ? (
                    <Button
                      onClick={(event) => {
                        event.stopPropagation();
                        setCursor([]);
                        setFilters({ requestId: entry.requestId! });
                      }}
                      size="sm"
                      variant="outline"
                    >
                      Whole request
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        {cursor.length ? (
          <Button onClick={() => setCursor((c) => c.slice(0, -1))} size="sm" variant="outline">
            Newer
          </Button>
        ) : null}
        {resource.data?.nextCursor ? (
          <Button onClick={() => setCursor((c) => [...c, resource.data!.nextCursor!])} size="sm" variant="outline">
            Older
          </Button>
        ) : null}
      </div>
      {summary?.dropped ? <p className="text-xs text-muted-foreground">{summary.dropped} lines dropped by the store since start.</p> : null}
      {summary ? <LevelControls categories={summary.categories} /> : null}
    </div>
  );
}

/* ── Process ── */

type Process = {
  instance: { commit: string; goMaxProcs: number; goVersion: string; hostname: string; numCPU: number; pid: number; startedAt: string; uptimeSeconds: number };
  mongo: { checkoutFailures?: number; ok: boolean; pingMs: number; poolInUse?: number };
  recent: LogEntry[];
  runtime: { goroutines: number; heapAllocBytes: number; heapSysBytes: number; lastPauseMs: number; nextGCBytes: number; numGC: number; pauseTotalMs: number; sysBytes: number };
};

function ProcessTab() {
  const resource = usePortalResource<Process>("/api/v1/platform/system/process");
  const data = resource.data;

  return (
    <div className="space-y-4">
      <Message value={resource.message} />
      {resource.state === "loading" && !data ? <LoadingRows /> : null}
      {data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <MetricCard icon={Clock} label="Up" note={when(data.instance.startedAt)} value={uptime(data.instance.uptimeSeconds)} />
            <MetricCard icon={Activity} label="Goroutines" value={data.runtime.goroutines} />
            <MetricCard label="Heap" note={`${bytes(data.runtime.sysBytes)} from the OS`} value={bytes(data.runtime.heapAllocBytes)} />
            <MetricCard
              label="Mongo"
              note={`${data.mongo.poolInUse ?? 0} in use`}
              tone={data.mongo.ok ? "teal" : "rose"}
              value={data.mongo.ok ? `${data.mongo.pingMs.toFixed(1)} ms` : "down"}
            />
          </div>
          <Panel title="Instance">
            <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
              {[
                ["Host", data.instance.hostname],
                ["PID", data.instance.pid],
                ["Go", data.instance.goVersion],
                ["Commit", data.instance.commit ? data.instance.commit.slice(0, 12) : "—"],
                ["CPUs", `${data.instance.goMaxProcs} of ${data.instance.numCPU}`],
                ["GC runs", data.runtime.numGC],
                ["Last GC pause", `${data.runtime.lastPauseMs.toFixed(2)} ms`],
                ["GC pause total", `${data.runtime.pauseTotalMs.toFixed(0)} ms`],
              ].map(([label, value]) => (
                <div className="flex justify-between gap-3" key={String(label)}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="font-mono">{value}</dd>
                </div>
              ))}
            </dl>
          </Panel>
          <Panel title="Boot, jobs, database, redis, panics">
            {data.recent.length === 0 ? (
              <EmptyState label="Nothing stored yet." />
            ) : (
              <div className="divide-y divide-border">
                {data.recent.map((entry) => (
                  <div className="flex items-center gap-2 py-2 text-sm" key={entry.id}>
                    <SoftBadge tone={LEVEL_TONE[entry.level]}>{entry.level}</SoftBadge>
                    <span className="font-mono text-xs text-muted-foreground">{entry.category}</span>
                    <span className="min-w-0 flex-1 truncate">{entry.message}</span>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{when(entry.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}

/* ── Active users ── */

/** The beacon's client values: the native app, the same app as a PWA, the website. */
const CLIENT_LABELS: Record<string, string> = { app: "App", pwa: "PWA", web: "Web" };
const clientLabel = (client: string) => CLIENT_LABELS[client] ?? client;

type ActiveUsers = {
  dau: number;
  day: string;
  mau: number;
  people: { clients: string[]; firstSeen: string; hostelName: string | null; lastSeen: string; name: string; opens: number; role: string; userId: string }[];
  series: { byClient: Record<string, number>; byRole: Record<string, number>; day: string; users: number }[];
  wau: number;
};

function ActiveUsersTab() {
  const [day, setDay] = useState<string | null>(null);
  const resource = usePortalResource<ActiveUsers>(`/api/v1/platform/system/active-users?days=30${day ? `&day=${day}` : ""}`);
  const data = resource.data;
  const top = Math.max(1, ...(data?.series.map((row) => row.users) ?? []));
  const time = (iso: string) => new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  return (
    <div className="space-y-4">
      <Message value={resource.message} />
      {resource.state === "loading" && !data ? <LoadingRows /> : null}
      {data ? (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <MetricCard icon={Users} label={`Active on ${data.day}`} value={data.dau} />
            <MetricCard label="Last 7 days" value={data.wau} />
            <MetricCard label="Last 30 days" value={data.mau} />
          </div>
          <Panel title="Daily active, Kathmandu days">
            <div className="flex h-32 items-end gap-1">
              {data.series.map((row) => (
                <button
                  aria-label={`${row.day}: ${row.users}`}
                  className={`flex-1 rounded-t ${row.day === data.day ? "bg-primary" : "bg-primary/40 hover:bg-primary/70"}`}
                  key={row.day}
                  onClick={() => setDay(row.day)}
                  style={{ height: `${Math.max(2, (row.users / top) * 100)}%` }}
                  title={`${row.day}: ${row.users} · ${Object.entries(row.byRole).map(([r, n]) => `${r} ${n}`).join(", ")} · ${Object.entries(row.byClient).map(([c, n]) => `${clientLabel(c)} ${n}`).join(", ")}`}
                  type="button"
                />
              ))}
            </div>
            {(() => {
              const chosen = data.series.find((row) => row.day === data.day);
              if (!chosen) return null;
              const split = (counts: Record<string, number>, label: (key: string) => string) =>
                Object.entries(counts).map(([key, n]) => `${label(key)} ${n}`).join(" · ") || "—";
              return (
                <p className="mt-2 text-xs text-muted-foreground">
                  {data.day}: {split(chosen.byClient, clientLabel)} · {split(chosen.byRole, (role) => role)}
                </p>
              );
            })()}
          </Panel>
          <Panel title={`Who was active on ${data.day}`}>
            {data.people.length === 0 ? (
              <EmptyState label="Nobody that day." />
            ) : (
              <div className="divide-y divide-border">
                {data.people.map((person) => (
                  <div className="flex items-center gap-3 py-2 text-sm" key={person.userId}>
                    <span className="min-w-0 flex-1 truncate font-medium">{person.name || person.userId}</span>
                    <span className="text-xs text-muted-foreground">{person.role.toLowerCase().replace(/_/g, " ")}</span>
                    <span className="hidden min-w-0 truncate text-xs text-muted-foreground sm:block">{person.hostelName ?? ""}</span>
                    <span className="text-xs text-muted-foreground">{person.clients.map(clientLabel).join(" · ")}</span>
                    <span className="shrink-0 text-xs tabular-nums">
                      {time(person.firstSeen)}–{time(person.lastSeen)} · {person.opens} opens
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Panel>
        </>
      ) : null}
    </div>
  );
}
