import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";

/**
 * The superadmin System area: the Go server's own routes (`goOnlyAllowed`), the
 * same ones the web's System tabs read (`platform-system-page.tsx`). They answer
 * once the app's API host is the Go server (cut-over); until then the screens
 * show the error state with a retry.
 */

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export type LogEntry = {
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

export type LogFilters = Partial<Record<"category" | "from" | "hostelId" | "level" | "q" | "requestId" | "route" | "to" | "userId", string>>;

export type LogSummary = {
  categories: string[];
  counts: { category: string; count: number; level: string }[];
  dropped: number;
};

export type Health = {
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

export type CronStatus = "failed" | "ok" | "running" | "skipped" | "timeout";
export type CronTrigger = "http" | "manual" | "schedule";

export type CronRun = {
  counts: unknown;
  deadlineAt: string;
  durationMs: number | null;
  endedAt: string | null;
  error: string | null;
  instance: string;
  job: string;
  runId: string;
  startedAt: string;
  status: CronStatus;
  trigger: CronTrigger;
};

export type CronJob = {
  deadlineSeconds: number;
  lastOkAt: string | null;
  lastRun: CronRun | null;
  missed: boolean;
  name: string;
  nextRunAt: string | null;
  schedule: string | null;
};

export type ProcessInfo = {
  instance: { commit: string; goMaxProcs: number; goVersion: string; hostname: string; numCPU: number; pid: number; startedAt: string; uptimeSeconds: number };
  mongo: { checkoutFailures?: number; ok: boolean; pingMs: number; poolInUse?: number };
  recent: LogEntry[];
  runtime: { goroutines: number; heapAllocBytes: number; heapSysBytes: number; lastPauseMs: number; nextGCBytes: number; numGC: number; pauseTotalMs: number; sysBytes: number };
};

export type ActiveUsers = {
  dau: number;
  day: string;
  mau: number;
  people: { clients: string[]; firstSeen: string; hostelName: string | null; lastSeen: string; name: string; opens: number; role: string; userId: string }[];
  series: { byClient: Record<string, number>; byRole: Record<string, number>; day: string; users: number }[];
  wau: number;
};

type UsageRow = { durationMs?: number; opens?: number; users?: number; uses?: number; views?: number };

export type UsageAnalytics = {
  byHostel: (UsageRow & { hostelId: string; hostelName: string })[];
  byRole: (UsageRow & { role: string })[];
  days: number;
  features: (UsageRow & { feature: string })[];
  recent: { at: string; durationMs?: number; feature?: string; kind: string; screen?: string }[];
  screens: (UsageRow & { screen: string })[];
  totals: { durationMs: number; opens: number; users: number; uses: number; views: number };
  user: { email: string | null; name: string; userId: string } | null;
  users: (UsageRow & { email: string | null; hostelName: string | null; name: string; role?: string; userId: string })[];
};

const query = (params: Record<string, string | number | undefined>) => {
  const pairs = Object.entries(params).filter(([, value]) => value !== undefined && value !== "");
  return pairs.length ? `?${pairs.map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`).join("&")}` : "";
};

const get = async <T>(path: string) => unwrap(await api.get<ApiEnvelope<T>>(path));

export const listLogs = (filters: LogFilters, cursor?: string) =>
  get<{ entries: LogEntry[]; nextCursor: string | null }>(`/platform/logs${query({ ...filters, cursor })}`);

export const getLogSummary = () => get<LogSummary>("/platform/logs/summary");

export const getHealth = async () => (await get<{ health: Health }>("/platform/logs/health")).health;

/** The stored level per category, from the `logs` site-config section. */
export const getLogLevels = async () =>
  (await get<{ config: { logs?: { levels: Record<string, string> } } }>("/platform/site-config")).config.logs?.levels ?? {};

export const setLogLevels = async (levels: Record<string, string>) =>
  unwrap(await api.put<ApiEnvelope<unknown>>("/platform/site-config/logs", { levels }));

export const getProcess = () => get<ProcessInfo>("/platform/system/process");

export const listCronJobs = async () => (await get<{ jobs: CronJob[] }>("/platform/system/cron")).jobs;

export const listCronRuns = (filters: Partial<Record<"job" | "status" | "trigger", string>>, cursor?: string) =>
  get<{ nextCursor: string | null; runs: CronRun[] }>(`/platform/system/cron/runs${query({ ...filters, cursor })}`);

/** Run now: the job's own door, with the superadmin's session (trigger `manual`). */
export const runCronJob = async (name: string) =>
  unwrap(await api.post<ApiEnvelope<unknown>>(`/cron/${encodeURIComponent(name)}`, {}));

export const getActiveUsers = (day?: string) => get<ActiveUsers>(`/platform/system/active-users${query({ day, days: 30 })}`);

export const getUsage = (days: number, userId?: string) => get<UsageAnalytics>(`/platform/usage${query({ days, userId })}`);

/** The beacon's client values: the native app, the same app as a PWA, the website. */
export const clientLabel = (client: string) => ({ app: "App", pwa: "PWA", web: "Web" })[client] ?? client;

export const levelTone = (level: string) =>
  (({ debug: "neutral", error: "danger", info: "info", warn: "warning" }) as const)[level as LogLevel] ?? "neutral";

export const runTone = (status: CronStatus) =>
  (({ failed: "danger", ok: "success", running: "info", skipped: "neutral", timeout: "warning" }) as const)[status];

export const percent = (value: number) => `${(value * 100).toFixed(value < 0.01 && value > 0 ? 2 : 1)}%`;

export function uptime(seconds: number) {
  const hours = Math.floor(seconds / 3600);

  return hours >= 24 ? `${Math.floor(hours / 24)}d ${hours % 24}h` : `${hours}h ${Math.floor((seconds % 3600) / 60)}m`;
}

export const megabytes = (n: number) => (n >= 1 << 30 ? `${(n / (1 << 30)).toFixed(2)} GB` : `${(n / (1 << 20)).toFixed(1)} MB`);

export function duration(ms: number) {
  const minutes = Math.round(ms / 60_000);

  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}
