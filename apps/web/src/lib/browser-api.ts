import { refreshSession } from "@/lib/auth-refresh";

type ApiPayload<T> =
  | {
      success: true;
      message: string;
      data: T;
    }
  | {
      success: false;
      message: string;
      errorCode: string;
      details?: unknown;
    };

export class ApiRequestError extends Error {
  details?: unknown;
  errorCode?: string;
  status?: number;

  constructor(message: string, details?: unknown, status?: number, errorCode?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.details = details;
    this.errorCode = errorCode;
    this.status = status;
  }
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

/**
 * Auth endpoints (login, refresh, me, …) manage their own token lifecycle.
 * A 401 from them is a real credential failure — refreshing and retrying would
 * be wrong (e.g. retrying a failed login) and could loop, so skip the interceptor.
 */
function isAuthEndpoint(url: string): boolean {
  return url.includes("/api/v1/auth/");
}

function redirectToLogin(): void {
  if (typeof window === "undefined") {
    return;
  }

  // Avoid a redirect loop if we're already on the login screen.
  if (window.location.pathname.startsWith("/login")) {
    return;
  }

  const next = encodeURIComponent(window.location.pathname + window.location.search);
  window.location.assign(`/login?next=${next}`);
}

/**
 * The account's resident profile is gone — the hostel deleted it. The server
 * has already handed the account back its public role, but the access token in
 * this tab still says RESIDENT, which is the only reason the resident portal
 * still renders. So refresh to pick up the new role and drop the person on the
 * public site, still signed in. They keep their account; they just are not a
 * resident any more.
 */
let leavingResidentPortal = false;

function leaveResidentPortal(): void {
  // Several resident calls usually fail together on one screen; the first one
  // owns the exit.
  if (typeof window === "undefined" || leavingResidentPortal) {
    return;
  }

  leavingResidentPortal = true;

  void refreshSession()
    .catch(() => false)
    .then((refreshed) => {
      // A refresh that fails leaves a RESIDENT token in place, and the portal
      // would only break again — the session has to end in that case.
      window.location.assign(refreshed ? "/" : "/login?error=resident_removed");
    });
}

/**
 * A role change (resident linked to a hostel, owner approved as hostel admin)
 * takes effect in the database immediately, but the access token in the browser
 * still carries the old role until it is refreshed. The symptom is nasty: pages
 * render and /auth/me reports the new role — it reads the database — while every
 * API call 403s, and the only cure the user could find was signing out.
 *
 * So a FORBIDDEN answer gets one silent refresh + replay. `refreshAccessToken`
 * re-reads the role from the database, so a genuinely promoted user heals
 * mid-session without noticing. Once per page load: a user who is simply not
 * allowed must not set off a refresh on every request.
 */
let roleHealAttempted = false;

/** Test seam — the heal is once per page load, which a test cannot reload. */
export function resetRoleHealForTests() {
  roleHealAttempted = false;
}

/**
 * The hostel this page is working in, for staff with more than one (an owner
 * and their branches): the slug in `/{slug}/admin`. The server narrows every
 * request to it (`x-hostel-id`, see `activeHostel` in `api-auth.ts`); a page
 * outside a workspace sends nothing and gets the main hostel.
 */
export function workspaceSlug() {
  if (typeof window === "undefined") return null;

  return /^\/([^/]+)\/admin(?:\/|$)/.exec(window.location.pathname)?.[1] ?? null;
}

function sendRequest(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);

  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const slug = workspaceSlug();

  if (slug && !headers.has("x-hostel-id")) {
    headers.set("x-hostel-id", decodeURIComponent(slug));
  }

  return fetch(input, {
    credentials: "same-origin",
    ...init,
    headers,
  });
}

async function parseResponse<T>(
  response: Response,
  input: RequestInfo | URL,
): Promise<T> {
  const text = await response.text();
  let payload: ApiPayload<T>;

  try {
    payload = JSON.parse(text) as ApiPayload<T>;
  } catch {
    const isHtml = text.trim().startsWith("<!");
    throw new Error(
      isHtml
        ? `Server returned an HTML page (${response.status}). The API endpoint "${requestUrl(input)}" may not exist or there is a server error.`
        : `Invalid JSON response (${response.status}) from the server.`,
    );
  }

  if (!response.ok || !payload.success) {
    const errorCode = "errorCode" in payload ? payload.errorCode : undefined;

    // Every resident screen would otherwise render its own broken empty state,
    // so this is handled once here rather than page by page.
    if (errorCode === "RESIDENT_PROFILE_NOT_FOUND") {
      leaveResidentPortal();
    }

    throw new ApiRequestError(
      payload.message || "Request failed",
      "details" in payload ? payload.details : undefined,
      response.status,
      errorCode,
    );
  }

  return payload.data;
}

/**
 * Reads a `progressResponse` stream: every `{ step }` line goes to `onStep` as
 * it arrives, and the final `{ data }` or `{ error }` line settles the call the
 * way a JSON envelope would. A stream that ends with neither was cut off.
 */
async function readProgress<T>(response: Response, onStep: (step: string) => void): Promise<T> {
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  while (reader) {
    const { done, value } = await reader.read();
    buffered += decoder.decode(value, { stream: !done });

    const lines = buffered.split("\n");
    buffered = done ? "" : (lines.pop() ?? "");

    for (const line of lines) {
      if (!line.trim()) continue;

      const event = JSON.parse(line) as {
        data?: T;
        error?: { errorCode?: string; message?: string };
        step?: string;
      };

      if (event.step) onStep(event.step);
      else if (event.error) {
        throw new ApiRequestError(
          event.error.message || "Request failed",
          undefined,
          response.status,
          event.error.errorCode,
        );
      } else if ("data" in event) return event.data as T;
    }

    if (done) break;
  }

  throw new ApiRequestError("The connection dropped before it finished. Please try again.");
}

export async function browserApi<T>(
  input: RequestInfo | URL,
  init?: RequestInit,
  /** Ask for a `progressResponse` stream and hear each step as it starts. */
  onStep?: (step: string) => void,
) {
  if (onStep) {
    const headers = new Headers(init?.headers);
    headers.set("accept", "application/x-ndjson");
    init = { ...init, headers };
  }

  const settle = (res: Response) =>
    onStep && res.ok && res.headers.get("content-type")?.startsWith("application/x-ndjson")
      ? readProgress<T>(res, onStep)
      : parseResponse<T>(res, input);

  const response = await sendRequest(input, init);
  const isAuthCall = isAuthEndpoint(requestUrl(input));

  // Access token expired mid-session: transparently refresh once, then replay
  // the original request.
  if (response.status === 401 && !isAuthCall) {
    const refreshed = await refreshSession();

    if (refreshed) {
      const retry = await sendRequest(input, init);
      return settle(retry);
    }

    // Refresh token is gone or invalid — the session is truly over.
    redirectToLogin();
    throw new ApiRequestError(
      "Your session has expired. Please sign in again.",
      undefined,
      401,
    );
  }

  // 403 usually means "authenticated but not allowed", which no refresh fixes.
  // The exception is a role that changed under the session — see roleHealAttempted.
  if (response.status === 403 && !isAuthCall && !roleHealAttempted) {
    // The flag is set only once the refresh settles, so the several requests a
    // dashboard fires in parallel all ride the same single-flight refresh and
    // all get replayed. Flipping it up-front would heal one panel and leave the
    // rest showing a permission error.
    const refreshed = await refreshSession();
    roleHealAttempted = true;

    if (refreshed) {
      const retry = await sendRequest(input, init);
      return settle(retry);
    }
  }

  return settle(response);
}
