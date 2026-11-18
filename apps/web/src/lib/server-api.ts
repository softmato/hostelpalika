import "server-only";

import { headers } from "next/headers";

import { ApiBreaker } from "@hostel/constants/api-failover";
import { siteUrl } from "@/lib/site";

/**
 * Server-side reads from the Go API (server/docs/PARITY.md §9): the web holds no
 * database. `API_URL` is required in production — a build that falls back to its
 * own origin prerenders against nothing, which is how `9a29795f` broke every
 * deploy. In development it defaults to the local Go stack.
 */
export function apiBase() {
  const url = process.env.API_URL || (process.env.NODE_ENV === "production" ? "" : "http://127.0.0.1:8080");

  if (!url) throw new Error("API_URL is not set: the web reads every page's data from the Go API.");

  return url.replace(/\/+$/, "");
}

export class ServerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

type Options = {
  /**
   * Seconds the answer may be served from Next's data cache. Defaults to the
   * layouts' window (`PAGE_REVALIDATE`): a shorter one here would shorten the
   * page's own and re-render it that often. Go clears it on a change
   * (`POST /api/revalidate`). `0` = never cached.
   */
  revalidate?: number;
  /** Forward the visitor's cookies, for a signed-in read. Never cached. */
  session?: boolean;
  /**
   * `[HOSTELS_TAG]` on a read whose page shows listing data (beds, rent,
   * profile), so a listing change re-renders only those pages, not all ~700.
   */
  tags?: string[];
};

/**
 * The window every layout uses. A day, because every change a page shows is
 * cleared on demand: listings by `HOSTELS_TAG`, the website config by a
 * whole-site revalidate (app/api/revalidate). Each early re-render is CPU,
 * and a changed one is ISR writes.
 */
export const PAGE_REVALIDATE = 86400;

/** Tag on reads of listing data; `revalidatePublicPages` clears it. */
export const HOSTELS_TAG = "hostels";

let breaker: ApiBreaker | null = null;

/** Go first; this deployment's own TS routes while Go is unreachable (api-failover.ts). */
function serverBreaker() {
  breaker ??= new ApiBreaker(apiBase(), siteUrl().replace(/\/+$/, ""));
  return breaker;
}

/** GET `path` (e.g. `/api/v1/public/hostels`) and return the envelope's `data`. */
export async function serverApi<T>(path: string, options: Options = {}): Promise<T> {
  const revalidate = options.session ? 0 : (options.revalidate ?? PAGE_REVALIDATE);
  const cookie = options.session ? (await headers()).get("cookie") : null;
  const response = await serverBreaker().fetch(path, {
    headers: { accept: "application/json", ...(cookie ? { cookie } : {}) },
    ...(revalidate === 0 ? { cache: "no-store" as const } : { next: { revalidate, tags: options.tags } }),
  });
  const body = (await response.json().catch(() => null)) as {
    data?: T;
    errorCode?: string;
    message?: string;
  } | null;

  if (!response.ok || !body) {
    throw new ServerApiError(response.status, body?.errorCode, body?.message ?? `API ${response.status} on ${path}`);
  }

  return body.data as T;
}
