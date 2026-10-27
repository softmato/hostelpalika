"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

import { API_WRITE_EVENT } from "@/lib/browser-api";

/**
 * The web half of our usage watcher (FIELD_REVIEW H3), mounted once in the
 * portal shell, so only signed-in portal pages are watched. Time on each page,
 * an open each time the tab comes back to the front, and every API write as a
 * feature. Buffered in memory and posted in batches; a hidden tab sends with
 * `keepalive`, so closing it does not lose the last page. The server turns
 * paths into names (`/:hostel/admin/residents/:id`) — ids never become one.
 */
type UsageEvent = {
  at: string;
  durationMs?: number;
  feature?: string;
  kind: "feature" | "open" | "screen";
  screen?: string;
};

const ENDPOINT = "/api/v1/usage/events";
const FLUSH_EVERY_MS = 30_000;
const MIN_SCREEN_MS = 500;
const MAX_QUEUE = 500;

let queue: UsageEvent[] = [];

function push(event: Omit<UsageEvent, "at">) {
  queue.push({ ...event, at: new Date().toISOString() });
  if (queue.length > MAX_QUEUE) queue = queue.slice(-MAX_QUEUE);
}

function flush(keepalive = false) {
  if (queue.length === 0) return;

  const events = queue.slice(0, 200);
  queue = queue.slice(200);

  // Never awaited by a page; a failed batch is dropped rather than retried in a loop.
  void fetch(ENDPOINT, {
    body: JSON.stringify({ client: "web", events }),
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    keepalive,
    method: "POST",
  }).catch(() => undefined);
}

export function UsageWatcher() {
  const pathname = usePathname();
  const current = useRef({ screen: pathname, since: 0 });

  useEffect(() => {
    current.current.since = Date.now();
    push({ kind: "open" });

    const onWrite = (event: Event) => {
      const detail = (event as CustomEvent<{ method: string; url: string } | undefined>).detail;
      if (detail && !detail.url.includes("/usage/events")) {
        push({ feature: `${detail.method} ${detail.url}`, kind: "feature" });
      }
    };
    const onVisibility = () => {
      const now = Date.now();

      if (document.visibilityState === "hidden") {
        const elapsed = now - current.current.since;
        if (elapsed >= MIN_SCREEN_MS) push({ durationMs: elapsed, kind: "screen", screen: current.current.screen });
        flush(true);
      } else {
        push({ kind: "open" });
      }
      current.current.since = now;
    };
    const timer = window.setInterval(() => flush(), FLUSH_EVERY_MS);

    window.addEventListener(API_WRITE_EVENT, onWrite);
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      window.clearInterval(timer);
      window.removeEventListener(API_WRITE_EVENT, onWrite);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  useEffect(() => {
    const now = Date.now();
    const previous = current.current;

    if (previous.screen !== pathname) {
      if (now - previous.since >= MIN_SCREEN_MS && document.visibilityState === "visible") {
        push({ durationMs: now - previous.since, kind: "screen", screen: previous.screen });
      }
      current.current = { screen: pathname, since: now };
    }
  }, [pathname]);

  return null;
}
