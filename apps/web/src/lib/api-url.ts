import { ApiBreaker } from "@hostel/constants/api-failover";

/**
 * The one setting that says where the browser reaches the API. Empty means this
 * origin, which is the deployed TS server today; at cut-over it becomes
 * `https://api.hostelpalika.com` (server/docs/ARCHITECTURE.md §11).
 *
 * Only `/api/` paths move, so an R2 URL or an already absolute one passes through.
 */
const API_ORIGIN = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/+$/, "");

/** Go first; this origin's TS routes take over while Go is unreachable (api-failover.ts). */
const breaker = new ApiBreaker(API_ORIGIN, "");

export function apiUrl(path: string) {
  return path.startsWith("/api/") ? `${breaker.origin()}${path}` : path;
}

/** `fetch` for our API: on another host, cookies only travel when asked for. */
export function apiFetch(path: string, init?: RequestInit) {
  const options: RequestInit = { credentials: "include", ...init };
  return path.startsWith("/api/") ? breaker.fetch(path, options) : fetch(path, options);
}

/**
 * Pusher's own auth request sends no cookies to another host, so channel
 * authorization goes through {@link apiFetch} with the same form body.
 */
export const pusherChannelAuth = {
  customHandler: (
    params: { channelName: string; socketId: string },
    callback: (error: Error | null, data: { auth: string } | null) => void,
  ) => {
    void apiFetch("/api/v1/realtime/auth", {
      body: new URLSearchParams({ channel_name: params.channelName, socket_id: params.socketId }),
      method: "POST",
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Channel authorization failed (${response.status})`);
        return response.json() as Promise<{ auth: string }>;
      })
      .then(
        (data) => callback(null, data),
        (error: Error) => callback(error, null),
      );
  },
  endpoint: "/api/v1/realtime/auth",
  transport: "ajax" as const,
};
