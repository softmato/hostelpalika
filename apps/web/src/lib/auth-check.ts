import { apiFetch } from "@/lib/api-url";
import { refreshSession } from "@/lib/auth-refresh";

/**
 * "Who is signed in?", answered with a token that is still true.
 *
 * Two different staleness problems, healed in the one place every shell already
 * asks the question.
 *
 * 1. **The token expired.** A 401 is refreshed once and the question re-asked.
 * 2. **The account changed under the token.** `/auth/me` reads the database and
 *    reports `sessionStale` when the access token's role or hostels no longer
 *    match it. That is the registration case: a hostel promotes somebody's
 *    PUBLIC account to RESIDENT, and their tab keeps a PUBLIC token — the shell
 *    draws the public site, and every resident route would refuse them. Nothing
 *    401s, so case 1 never fires; `browser-api`'s 403 heal never fires either,
 *    because the public site calls no resident route to be refused by.
 *
 * Refreshing re-reads the role from the database (`refreshAccessToken`), so one
 * rotation puts the tab on the right side of every guard. The second answer is
 * returned rather than the first: a caller that rendered the stale one would
 * paint the public header over an account that is now a resident.
 */
export async function checkAuthWithRefresh(): Promise<Response> {
  let res = await apiFetch("/api/v1/auth/me");

  if (res.status === 401) {
    // Shared single-flight refresh: if a data request already kicked off a
    // refresh, we await the same one instead of racing it (which would rotate
    // the refresh token twice and kill the session).
    const refreshed = await refreshSession();

    if (refreshed) {
      res = await apiFetch("/api/v1/auth/me");
    }

    return res;
  }

  if (!(await isStaleSession(res))) {
    return res;
  }

  const refreshed = await refreshSession();

  return refreshed
    ? await apiFetch("/api/v1/auth/me")
    : res;
}

/**
 * Reads the flag without consuming the response the caller still has to parse.
 *
 * `res.clone()` rather than `res.json()`: the body is a one-shot stream, and
 * reading it here would leave every caller of this function parsing an already
 * consumed response. A body that is not the shape we expect is not stale — an
 * older API that has never heard of the flag must not send tabs into a refresh
 * loop.
 */
async function isStaleSession(response: Response): Promise<boolean> {
  if (!response.ok) {
    return false;
  }

  try {
    const payload = (await response.clone().json()) as {
      data?: { user?: { sessionStale?: unknown } };
    };

    return payload?.data?.user?.sessionStale === true;
  } catch {
    return false;
  }
}
