/**
 * Everything that starts, refreshes or ends a session.
 *
 * The boot contract (docs/MOBILE_APP_PHASES.md §0):
 *
 *   1. Splash stays up while we read SecureStore.
 *   2. If a token is there, route from the *cached* account immediately — no
 *      await on the network. This is the whole point: a warm start must never
 *      flash the login screen on its way to the dashboard.
 *   3. Only then does `revalidate()` run, confirming the token and the role are
 *      still what we cached. If they changed, we re-route; if the token is
 *      dead, the axios interceptor ends the session.
 *   4. With no token, we route to login before the splash hides.
 *
 * Step 2 and step 3 are deliberately not awaited together. Awaiting `/auth/me`
 * before the first navigation is the bug this whole file exists to avoid — it
 * turns every cold start into a second of blank screen on a slow connection.
 */

import { router } from "expo-router";

import { bindSessionHandlers, rotateAccessToken } from "@/lib/api";
import {
  type ApiUser,
  fetchActivationStatus,
  fetchMe,
  logout as revokeSession,
} from "@/lib/auth-api";
import { disarmFingerprint } from "@/lib/app-lock";
import { revokePushToken } from "@/lib/push-notifications";
import { setActiveHostelId } from "@/lib/active-hostel";
import { clearQueryCache } from "@/lib/query-cache";
import { resetUploadNotifications } from "@/lib/upload-notifier";
import { clearTokens, readTokens, writeTokens } from "@/lib/session";
import { persistor, resetStore, store } from "@/store";
import {
  clearAuth,
  setAccessToken,
  setAccount,
  setReady,
  setResidentActivated,
  setSession,
  setSessionEndReason,
} from "@/store/slices/authSlice";
import { resolveHome, ROLE } from "@/constants/roles";

/** Wire the HTTP layer to the store once, at module load. */
bindSessionHandlers({
  getAccessToken: () => store.getState().auth.accessToken,
  onAccessToken: (token) => store.dispatch(setAccessToken(token)),
  onSessionEnded: async (reason) => {
    await endSession({ reason, revoke: false });

    /*
     * A suspended account needs to be told why, so it lands on the login screen
     * where that message is shown. An expired session is ordinary — drop back
     * to the public app the same way the website does, rather than confronting
     * someone with a login form they did not ask for. The reason is still on
     * the store, so the login screen explains itself if they go there.
     */
    router.replace(reason === "SUSPENDED" ? "/(auth)/login" : "/(browse)");
  },
});

export type BootResult = {
  account: ApiUser | null;
  isResidentActivated: boolean | null;
};

/**
 * Reads persisted credentials and puts the token back in memory.
 *
 * Returns the *cached* account — deliberately. Nothing here touches the
 * network.
 */
export async function bootstrapSession(): Promise<BootResult> {
  const tokens = await readTokens();
  const cached = store.getState().auth;

  if (!tokens) {
    // Tokens gone but an account still cached (app data cleared, keychain reset
    // on restore-from-backup) — drop the stale account so the gate sends the
    // user to login rather than to a dashboard that will 401 on first paint.
    if (cached.account) {
      store.dispatch(clearAuth());
    }

    return { account: null, isResidentActivated: null };
  }

  store.dispatch(setAccessToken(tokens.accessToken));

  return {
    account: cached.account,
    isResidentActivated: cached.isResidentActivated,
  };
}

/**
 * Confirms the cached account against the server. Runs *after* the first
 * navigation, so a slow or failed call costs nothing visible.
 *
 * Returns the fresh account when something changed and the caller should
 * re-route, or `null` when the cache was already correct.
 */
export async function revalidateSession(): Promise<ApiUser | null> {
  const before = store.getState().auth;

  if (!before.accessToken) {
    return null;
  }

  let account: ApiUser;

  try {
    account = await fetchMe();
  } catch {
    // A 401 has already been handled by the interceptor (refresh, or session
    // end). Anything else is a network blip — keep showing cached data rather
    // than logging someone out because their train went into a tunnel.
    return null;
  }

  store.dispatch(setAccount(account));

  const roleChanged = before.account?.role !== account.role;

  /*
   * A changed role has to reach the *token* before it reaches the router.
   *
   * `/auth/me` reads the user record, but every request is authorised from the
   * claims baked into the access token, so an account promoted elsewhere — a
   * hostel scanning somebody's ID card at the desk and registering them, which
   * turns a PUBLIC account into a RESIDENT one server-side — is still a public
   * user to this phone until its token expires. Re-routing on `/auth/me` alone
   * put them on a resident dashboard where every call came back refused, and
   * the 403s are not 401s, so nothing below would have refreshed either.
   *
   * Rotating first also makes the activation lookup underneath truthful: it is
   * a resident-only endpoint, and asking it with a public token answers
   * "not activated" for somebody who is.
   */
  if (roleChanged) {
    await rotateAccessToken();
  }

  let activated = before.isResidentActivated;

  if (account.role === ROLE.RESIDENT) {
    activated = await fetchActivationStatus().catch(() => activated);

    if (typeof activated === "boolean") {
      store.dispatch(setResidentActivated(activated));
    }
  }

  /*
   * A move is a change of *home*, not of a field.
   *
   * The provider and activation flags used to be compared on their own, and
   * neither is always known. Until 2026-09-11 sign-in payloads left
   * `isServiceProvider` out, so a fresh sign-in cached `undefined`, the first
   * `/auth/me` said `false`, and the two compared unequal: the first resume
   * after signing in — usually a picker closing — replaced the stack with the
   * resident's home from under "Submit payment proof" while the upload
   * finished behind it. An older server, or an account cached from one, still
   * answers that way. `null` activation is the same trap in the other flag.
   *
   * `resolveHome` is what every caller does with the answer, and it already
   * reads a missing flag the way the boot gate does. A changed role still counts
   * on its own: its token was just rotated above. `mustChangePassword` stays out
   * because it no longer decides where anyone lands.
   */
  const homeMoved =
    homeOf(before.account, before.isResidentActivated) !== homeOf(account, activated);

  return roleChanged || homeMoved ? account : null;
}

/** Where an account belongs, read the way the boot gate reads it. */
function homeOf(account: ApiUser | null, isResidentActivated: boolean | null) {
  return resolveHome(
    account
      ? {
          isApprovedProvider: account.isServiceProvider,
          // `null` is "not checked yet", not "not activated".
          isResidentActivated: isResidentActivated ?? true,
          role: account.role,
        }
      : null,
  );
}

/**
 * Re-read the account and, if it moved, put the app on the home its new role
 * implies.
 *
 * ## What this is for
 *
 * Being registered at a hostel desk promotes a `PUBLIC` account to `RESIDENT`
 * on the server, and the phone in the resident's pocket knows nothing about it:
 * its access token still carries the old claims, so it stays the public
 * browsing app for the rest of that token's life — through backgrounding,
 * through relaunches, through however long `ACCESS_TOKEN_TTL` has left. The
 * hostel has just taken their deposit and their app has not changed.
 *
 * The registration push is the signal, and this is what it triggers
 * (`usePush`). `revalidateSession` already does the hard half — it rotates the
 * token when the role changed, which is what makes the resident endpoints stop
 * refusing — and returns the account only when something actually moved, so a
 * push arriving at somebody who is already a resident routes nothing.
 *
 * ## `replace`, not `push`
 *
 * The public shell is not somewhere to go *back* to. Leaving `(browse)` under a
 * resident stack would let a back gesture return to tabs that no longer match
 * the account, which is the state this whole function exists to end.
 *
 * Silent on failure by design: an offline phone keeps the app it has, and the
 * ordinary boot revalidation corrects it on the next launch.
 */
export async function adoptRoleChange(): Promise<ApiUser | null> {
  const account = await revalidateSession();

  if (!account) {
    return null;
  }

  router.replace(homeOf(account, store.getState().auth.isResidentActivated));

  return account;
}

/** Called on every successful login, signup, Google exchange and QR activation. */
export async function startSession(result: {
  accessToken: string;
  refreshToken: string;
  user: ApiUser;
}) {
  await writeTokens({
    accessToken: result.accessToken,
    refreshToken: result.refreshToken,
  });

  // Signed-out reads (the community's `viewer.canPost`, above all) were cached
  // under the same keys; left in place they paint "Sign in" to a signed-in user.
  clearQueryCache();

  store.dispatch(setSession({ accessToken: result.accessToken, account: result.user }));

  if (result.user.role === ROLE.RESIDENT) {
    // Decides between the dashboard and the activation screen, so it is worth
    // one blocking call here — unlike on boot, the user is already waiting on a
    // button press and expects a moment of work.
    const activated = await fetchActivationStatus().catch(() => null);

    if (typeof activated === "boolean") {
      store.dispatch(setResidentActivated(activated));
    }
  }

  return store.getState().auth;
}

/**
 * Ends a session and leaves nothing behind.
 *
 * `revoke: false` is for the case where the refresh token is already dead —
 * calling `/auth/logout` with it would just 401.
 */
export async function endSession(options?: {
  reason?: "EXPIRED" | "SUSPENDED" | null;
  revoke?: boolean;
}) {
  const { reason = null, revoke = true } = options ?? {};

  /*
   * Before `clearTokens`, because this call is authenticated.
   *
   * Unconditional, unlike the session revoke below: `revoke: false` means the
   * *refresh* token is already dead, not that this device should carry on
   * receiving the departing account's notifications. The push row is keyed to a
   * user id and survives sign-out, so without this the previous account's
   * invoices, complaint replies and SOS alerts keep arriving on a handset it has
   * signed out of. Never throws — see `revokePushToken`.
   */
  await revokePushToken();

  /*
   * Clears the upload shade for the departing account. The tally is per-batch
   * and holds a label like "Payment proof"; leaving it posted would show the
   * next person to sign in on this handset what the last one was uploading.
   */
  resetUploadNotifications();

  /*
   * The in-memory half of `persistor.purge()` below.
   *
   * `lib/query-cache.ts` holds whole rosters, invoice matrices and claim
   * evidence for the account that is leaving. Hostel phones get handed around —
   * an owner signs out, a warden signs in — and a cache that survived that would
   * hand the next person the last one's resident list on their first tab switch.
   */
  clearQueryCache();
  // The branch the last account was in means nothing to the next one.
  await setActiveHostelId(null);

  if (revoke) {
    const tokens = await readTokens();

    if (tokens?.refreshToken) {
      await revokeSession(tokens.refreshToken);
    }
  }

  await clearTokens();
  // The lock belonged to the account leaving; `resetStore` drops its flag.
  await disarmFingerprint();

  store.dispatch(resetStore());
  await persistor.purge();

  // `resetStore` cleared it, so re-flag the two things the login screen needs:
  // that boot is done (otherwise the gate re-runs and hangs on the splash) and
  // why the user is here.
  store.dispatch(setReady(true));

  if (reason) {
    store.dispatch(setSessionEndReason(reason));
  }
}
