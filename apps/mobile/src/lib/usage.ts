import AsyncStorage from "@react-native-async-storage/async-storage";

import { api } from "@/lib/api";
import { store } from "@/store";

/**
 * Our own usage watcher (FIELD_REVIEW H3): app opens, time on each screen and
 * features used, buffered here and posted in batches to `/usage/events`. Never
 * awaited by a screen, never retried in a loop: a failed batch goes back on the
 * queue for the next flush, and the queue is capped.
 *
 * ## The storage seam
 *
 * `persist` / `restore` are the only two places the queue touches storage.
 * Phase 6's SQLite store replaces those two bodies; nothing else changes.
 */
type UsageEvent = {
  at: string;
  durationMs?: number;
  feature?: string;
  kind: "feature" | "open" | "screen";
  screen?: string;
};

const KEY = "usage-queue";
const MAX_QUEUE = 500;
const BATCH = 200;
const FLUSH_EVERY_MS = 30_000;
/** A flick through a screen on the way somewhere else is not time on it. */
const MIN_SCREEN_MS = 500;

let queue: UsageEvent[] = [];
let sending = false;

async function persist(events: UsageEvent[]) {
  await AsyncStorage.setItem(KEY, JSON.stringify(events)).catch(() => undefined);
}

async function restore(): Promise<UsageEvent[]> {
  const raw = await AsyncStorage.getItem(KEY).catch(() => null);
  await AsyncStorage.removeItem(KEY).catch(() => undefined);

  try {
    return raw ? (JSON.parse(raw) as UsageEvent[]) : [];
  } catch {
    return [];
  }
}

const signedIn = () => Boolean(store.getState().auth.account);

function push(event: Omit<UsageEvent, "at">) {
  // Queued even before the session has loaded (a cold start's open lands
  // first); only sent once someone is signed in, and capped meanwhile.
  queue.push({ ...event, at: new Date().toISOString() });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
}

export const trackOpen = () => push({ kind: "open" });

export function trackScreen(screen: string, durationMs: number) {
  if (durationMs >= MIN_SCREEN_MS) push({ durationMs: Math.round(durationMs), kind: "screen", screen });
}

/** Sends what is queued. Safe to call any time; overlapping calls are dropped. */
export async function flushUsage() {
  if (sending || queue.length === 0 || !signedIn()) return;

  sending = true;
  const batch = queue.slice(0, BATCH);
  queue = queue.slice(BATCH);

  try {
    await api.post("/usage/events", { client: "app", events: batch });
  } catch {
    queue = [...batch, ...queue].slice(-MAX_QUEUE);
  } finally {
    sending = false;
  }
}

/** Going to the background: send, and keep whatever did not go for next launch. */
export async function parkUsage() {
  await flushUsage();
  if (queue.length > 0) await persist(queue);
}

let started = false;

/** Once per launch: picks up last session's leftovers and starts the timer. */
export function startUsage() {
  if (started) return;
  started = true;

  void restore().then((left) => {
    queue = [...left, ...queue].slice(-MAX_QUEUE);
  });
  setInterval(() => void flushUsage(), FLUSH_EVERY_MS);

  // Features are the API writes a person made — one place, no per-screen calls.
  api.interceptors.response.use((response) => {
    const method = (response.config.method ?? "get").toUpperCase();
    const url = response.config.url ?? "";

    if (method !== "GET" && !url.includes("/usage/events") && !url.includes("/auth/")) {
      push({ feature: `${method} ${url.split("?")[0].replace(/\/[a-f\d]{24}(?=\/|$)/gi, "/:id")}`, kind: "feature" });
    }

    return response;
  });
}
