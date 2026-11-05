import "server-only";

/**
 * Server-side read from the API, for pages that used to query Mongo themselves
 * (server/docs/PARITY.md §9). `API_URL` is the Go API at cut-over; until then
 * it falls back to this deployment's own origin, where the TS routes answer the
 * same paths with the same JSON.
 */
const BASE = (process.env.API_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").replace(/\/+$/, "");

export class ServerApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

/** GET `path` (e.g. `/api/v1/public/hostels`) and return the envelope's `data`. */
export async function serverApi<T>(path: string, init?: { revalidate?: number | false }): Promise<T> {
  const response = await fetch(`${BASE}${path}`, {
    headers: { accept: "application/json" },
    next: { revalidate: init?.revalidate ?? 60 },
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
