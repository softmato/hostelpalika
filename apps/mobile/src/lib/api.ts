import { receiptNative } from "./receipt-native";
import { withSessionRefreshLock } from "@/lib/session-refresh-lock";
/**
 * The single HTTP client.
 *
 * Three responsibilities, in order:
 *  1. Resolve the API base URL — the deployed origin, unless
 *     `EXPO_PUBLIC_API_URL` overrides it. See {@link resolveApiBaseUrl}.
 *  2. Attach the access token to every request, plus the mobile client header
 *     that makes `/auth/login` return `refreshToken` in the JSON body instead of
 *     a cookie (apps/web/src/lib/mobile-auth.ts).
 *  3. On 401: refresh once, replay the queued requests, and if the refresh
 *     itself fails, end the session properly — wipe every slice, purge what is
 *     on disk, and send the user to login.
 *
 * The refresh **rotates**: the server invalidates the token it was given and
 * returns a new one, so both tokens are written back. `lib/refresh-tokens.ts`
 * has the reasoning and the failure mode that follows from getting it wrong.
 */

import {
  create,
  type AxiosError,
  type AxiosInstance,
  type InternalAxiosRequestConfig,
} from "axios";

import { getRequestHostelId, loadActiveHostel } from "@/lib/active-hostel";
import { AUTH_CLIENT_HEADER, MOBILE_AUTH_CLIENT } from "@/lib/api-contract";
import {
  accessTokenNeedsRefresh,
  readRefreshOutcome,
  type RefreshResponseBody,
} from "@/lib/refresh-tokens";
import { clearTokens, readTokens, writeAccessToken, writeTokens } from "@/lib/session";

/**
 * The deployed web app. It serves the API under `/api/v1`, and it is where every
 * build of this app talks unless `EXPO_PUBLIC_API_URL` says otherwise.
 */
const PRODUCTION_API_URL = "https://hostelpalika.com";

function trimTrailingSlash(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed.replace(/\/+$/, "") : "";
}

/**
 * The origin every request goes to.
 *
 * **Always the deployed app**, unless `EXPO_PUBLIC_API_URL` names something
 * else. There is no dev-machine branch and there must not be one again.
 *
 * There was: in a dev build it read the host Metro was served from and pointed
 * the API at port 3000 on that machine, on the theory that whoever runs Metro is
 * also running `npm run web:dev`. That is not how this project is worked on —
 * the phone talks to the deployed server, always — so what the branch actually
 * did was aim every request at a port with nothing behind it, and the failure it
 * produced was the worst kind: a `fetch` with no timeout, aimed at a private
 * address that neither answers nor refuses, hangs until the OS gives up. On the
 * claim screen that showed as "Opening your receipt…" and never anything else.
 * `10.0.2.2` made it worse still, because that address means the host machine
 * only on the Android *emulator* and means nothing at all on a real handset.
 *
 * So: one origin, named in one place, the same in every build.
 *
 * `EXPO_PUBLIC_API_URL` remains the override, and `eas.json` sets it explicitly
 * on `preview` and `production`. Point it at a LAN address when you genuinely do
 * want a local server — that is a deliberate choice someone typed, not a guess
 * this function made from the Metro host.
 */
export function resolveApiBaseUrl() {
  return trimTrailingSlash(process.env.EXPO_PUBLIC_API_URL) || PRODUCTION_API_URL;
}

export const API_BASE_URL = resolveApiBaseUrl();

function createClient(): AxiosInstance {
  return create({
    baseURL: `${API_BASE_URL}/api/v1`,
    headers: {
      "Content-Type": "application/json",
      [AUTH_CLIENT_HEADER]: MOBILE_AUTH_CLIENT,
    },
    timeout: 20000,
  });
}

/** Authenticated client. Use for everything except login/refresh. */
export const api = createClient();

/**
 * Unauthenticated client, and deliberately a *separate instance*: it has no
 * interceptors, so a 401 from `/auth/login` surfaces as "wrong password"
 * instead of triggering a refresh-and-logout cycle.
 */
export const publicApi = createClient();

/** Set by the store module on boot to avoid a require cycle (store → api → store). */
type SessionHandlers = {
  getAccessToken: () => string | null;
  onAccessToken: (token: string) => void;
  onSessionEnded: (reason: "EXPIRED" | "SUSPENDED") => Promise<void> | void;
};

let handlers: SessionHandlers | null = null;

export function bindSessionHandlers(next: SessionHandlers) {
  handlers = next;
}

/**
 * A rotated token that still reads as expiring means the phone's clock is off.
 * Remembered so that token is not refreshed again on every request.
 */
let skewedToken: string | null = null;

api.interceptors.request.use(async (config: InternalAxiosRequestConfig) => {
  // The share extension may rotate while the main app is suspended.
  const stored = receiptNative ? await readTokens() : null;
  let token = receiptNative ? stored?.accessToken : handlers?.getAccessToken() ?? (await readTokens())?.accessToken;
  if (receiptNative && token && token !== handlers?.getAccessToken()) handlers?.onAccessToken(token);

  /*
   * Refresh *before* sending, not after a 401. An expired token on an
   * optional-auth read (the community feed) would otherwise paint the screen
   * signed-out for a round trip. Waking the app after an hour lands here too, so
   * the first request after resume already carries a live token.
   */
  if (token && token !== skewedToken && accessTokenNeedsRefresh(token)) {
    const rotated = await rotateAccessToken();

    if (rotated) {
      token = rotated;

      if (accessTokenNeedsRefresh(rotated)) {
        skewedToken = rotated;
      }
    }
  }

  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }

  // The branch the owner is working in. The server ignores an id the account
  // does not hold, so a stale one is harmless — it answers for the main hostel.
  await loadActiveHostel();

  const hostelId = getRequestHostelId();

  if (!config.headers.has("x-hostel-id") && hostelId) {
    config.headers["x-hostel-id"] = hostelId;
  }

  return config;
});

// Axios runs request interceptors in reverse order. Capture the branch first,
// before token refresh can yield and the owner can switch to another branch.
api.interceptors.request.use((config) => {
  if (!config.headers.has("x-hostel-id")) {
    config.headers.set("x-hostel-id", getRequestHostelId() ?? "");
  }
  return config;
}, undefined, { synchronous: true });

let refreshing = false;
let waiters: ((token: string | null) => void)[] = [];

function releaseWaiters(token: string | null) {
  const pending = waiters;
  waiters = [];
  pending.forEach((resolve) => resolve(token));
}

/**
 * Rotate the session because the **account** changed, not because a request
 * failed.
 *
 * Every API call is authorised from the claims inside the access token
 * (`payload.role` in `lib/api-auth.ts`), not from the user record. So a public
 * account that a hostel has just registered as a resident — scanned at the desk,
 * promoted by `promoteAccountToResident` — is a RESIDENT in the database and a
 * PUBLIC one to every request this phone makes, for as long as the token in hand
 * lives (`ACCESS_TOKEN_TTL`, 15 minutes by default). `/auth/me` reads the
 * database and so notices immediately; routing to the resident portal on the
 * strength of that alone lands them on a dashboard whose every call is refused.
 * `/auth/refresh` re-reads the user, so one rotation closes that window.
 *
 * Shares the interceptor's `refreshing` flag and its waiter queue, deliberately:
 * a second, independent refresh path racing the first is how the loser writes an
 * already-invalid rotated token and the session dies for good.
 *
 * **Never ends the session.** A failure here means the caller keeps the token it
 * already had, which still works — unlike the interceptor, this is not running
 * over a request that has already been refused.
 */
export async function rotateAccessToken(): Promise<string | null> {
  if (refreshing) {
    return new Promise((resolve) => {
      waiters.push(resolve);
    });
  }

  refreshing = true;

  try {
    const accessToken = await refreshStoredSession();
    releaseWaiters(accessToken);

    return accessToken;
  } catch {
    releaseWaiters(null);

    return null;
  } finally {
    refreshing = false;
  }
}

async function refreshStoredSession(): Promise<string | null> {
  if (receiptNative) {
    const token = await receiptNative.refreshSession(API_BASE_URL);
    if (token) handlers?.onAccessToken(token);
    else await handlers?.onSessionEnded("EXPIRED");
    return token;
  }
  const before = await readTokens();
  return withSessionRefreshLock(async () => {
    const tokens = await readTokens();
    if (!tokens) return null;
    // Another PWA window has already rotated while this one waited.
    if (before && tokens.refreshToken !== before.refreshToken) {
      handlers?.onAccessToken(tokens.accessToken);
      return tokens.accessToken;
    }
    const response = await publicApi.post<RefreshResponseBody>("/auth/refresh", {
      refreshToken: tokens.refreshToken,
    });
    const outcome = readRefreshOutcome(response.data);
    if (!outcome.ok) throw new Error("Invalid refresh response");
    if (outcome.refreshToken) {
      await writeTokens({ accessToken: outcome.accessToken, refreshToken: outcome.refreshToken });
    } else {
      await writeAccessToken(outcome.accessToken);
    }
    handlers?.onAccessToken(outcome.accessToken);
    return outcome.accessToken;
  });
}

api.interceptors.response.use(
  (response) => response,
  async (error: AxiosError) => {
    const request = error.config as
      | (InternalAxiosRequestConfig & { _retried?: boolean })
      | undefined;

    if (!request || error.response?.status !== 401 || request._retried) {
      return Promise.reject(error);
    }

    // A refresh is already in flight — park this request rather than starting a
    // second one. Two parallel refreshes race, and the loser's rotated token is
    // already invalid by the time it is written.
    if (refreshing) {
      return new Promise((resolve, reject) => {
        waiters.push((token) => {
          if (!token) {
            reject(error);
            return;
          }

          request._retried = true;
          request.headers.Authorization = `Bearer ${token}`;
          resolve(api(request));
        });
      });
    }

    request._retried = true;
    refreshing = true;

    try {
      const accessToken = await refreshStoredSession();
      if (!accessToken) throw new Error("No saved session");
      releaseWaiters(accessToken);

      request.headers.Authorization = `Bearer ${accessToken}`;
      return api(request);
    } catch (refreshError) {
      releaseWaiters(null);
      const status = (refreshError as AxiosError)?.response?.status;
      // Offline, timeout, rate limiting and server failures are not revocations.
      // Keep the saved credentials so the next request can recover.
      if (status === 401 || status === 403) {
        await clearTokens();
        await handlers?.onSessionEnded(status === 403 ? "SUSPENDED" : "EXPIRED");
      }

      return Promise.reject(error);
    } finally {
      refreshing = false;
    }
  },
);
