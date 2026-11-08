import "server-only";

import { headers } from "next/headers";

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
   * public layouts' window (`revalidate = 21600`): a shorter one here would
   * shorten the page's own and re-render it that often. Go clears it on a change
   * (`POST /api/revalidate`). `0` = never cached.
   */
  revalidate?: number;
  /** Forward the visitor's cookies, for a signed-in read. Never cached. */
  session?: boolean;
};

/** GET `path` (e.g. `/api/v1/public/hostels`) and return the envelope's `data`. */
export async function serverApi<T>(path: string, options: Options = {}): Promise<T> {
  const revalidate = options.session ? 0 : (options.revalidate ?? 21600);
  const cookie = options.session ? (await headers()).get("cookie") : null;
  const response = await fetch(`${apiBase()}${path}`, {
    headers: { accept: "application/json", ...(cookie ? { cookie } : {}) },
    ...(revalidate === 0 ? { cache: "no-store" as const } : { next: { revalidate } }),
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
