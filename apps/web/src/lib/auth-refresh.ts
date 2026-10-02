/**
 * Single-flight session refresh.
 *
 * Every 401 in the browser funnels through here so that many concurrent
 * "access token expired" responses trigger exactly ONE call to
 * `/api/v1/auth/refresh`.
 *
 * This matters because {@link refreshAccessToken} rotates the refresh token on
 * the server (see auth.service.ts): the old refresh-token hash is replaced on
 * every successful refresh. If two refreshes ran in parallel, the second would
 * present an already-rotated token, fail with `INVALID_SESSION`, and tear down
 * the whole session — logging the user out even though they just refreshed.
 * De-duping the in-flight request removes that race.
 */
let inFlight: Promise<boolean> | null = null;

/**
 * Attempt to refresh the session using the httpOnly refresh-token cookie.
 * Resolves `true` when a fresh access-token cookie was issued, `false`
 * for rejected credentials. Throws on transient failures so callers keep the session.
 */
export function refreshSession(): Promise<boolean> {
  if (inFlight) {
    return inFlight;
  }

  inFlight = (async () => {
    try {
      const response = await fetch("/api/v1/auth/refresh", {
        credentials: "include",
        method: "POST",
      });

      if (!response.ok && response.status !== 401 && response.status !== 403) {
        throw new Error("Session refresh is temporarily unavailable. Please retry.");
      }
      return response.ok;
    } catch {
      throw new Error("Unable to refresh your session. Check your connection and retry.");
    }
  })();

  // Clear once settled so a later expiry can refresh again. Callers already
  // awaiting keep their own reference to the promise, so clearing here is
  // race-free — only *new* callers after settle start a fresh refresh.
  const clear = () => {
    inFlight = null;
  };
  void inFlight.then(clear, clear);

  return inFlight;
}
