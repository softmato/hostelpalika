/**
 * Auth endpoints, typed.
 *
 * `login`/`register`/`refresh` go through `publicApi` (no interceptors) so a
 * bad password reads as a bad password rather than kicking off a refresh cycle.
 */

import { api, publicApi } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import type { Role } from "@/constants/roles";

/** Exactly `publicUser()` + `isServiceProvider` from apps/web's auth.service.ts. */
export type ApiUser = {
  /**
   * COOK only: the owner asked cooks to lock the app with a fingerprint. Every
   * other role leaves it out — `lib/app-lock.ts` decides those by role.
   */
  cookFingerprintLock?: boolean;
  email: string | null;
  emailVerified: boolean;
  /**
   * The account has an app-lock PIN. One PIN per account: every phone signed
   * in to it locks (`lib/app-lock.ts`), and so does every web portal.
   * Optional: a cached account from before the PIN existed has nothing here.
   */
  hasLockPin?: boolean;
  hostelIds: string[];
  /**
   * Set while the account's hostel is in pre-suspension or suspended for an
   * unpaid plan; `HostelSuspensionHost` draws it. Optional: sign-in payloads
   * leave it out, and the boot revalidation fills it in.
   */
  hostelSuspension?: HostelSuspension | null;
  id: string;
  image: string | null;
  /** Provisioned accounts (cook, warden) must set their own password first. */
  mustChangePassword: boolean;
  /**
   * Approved service provider. No SERVICE_PROVIDER role exists — this is the flag.
   *
   * On `/auth/me`, every sign-in and every refresh. Still optional: a server
   * from before sign-ins carried it, or an account cached from one, answers
   * nothing — which `revalidateSession` reads by the home it implies rather
   * than as a change.
   */
  isServiceProvider?: boolean;
  name: string;
  phone: string | null;
  redirectPath: string;
  role: Role;
  status: string;
  userResidentId: string | null;
  /** Signed in with a temporary login — the owner's lock and PIN are not theirs. */
  viaTemporaryCredential?: boolean;
};

/** A hostel's plan suspension, as `/auth/me` reports it (apps/web `hostel-suspension.ts`). */
export type HostelSuspension = {
  graceEndsAt: string;
  hostelId: string;
  hostelName: string;
  reason: "PLAN_PAYMENT";
  stage: "PRE_SUSPENSION" | "SUSPENDED";
  startedAt: string;
};

export type LoginResult = {
  accessToken: string;
  /** Only returned because we send the mobile client header. */
  refreshToken: string;
  user: ApiUser;
};

export async function login(identifier: string, password: string) {
  const response = await publicApi.post<ApiEnvelope<LoginResult>>("/auth/login", {
    identifier,
    password,
  });

  return unwrap(response);
}

/**
 * Starts an email OTP challenge.
 *
 * **Email only, registration only.** This was typed with `"email" | "sms"` and
 * `"registration" | "password-reset"`, which is what the endpoint sounds like
 * it should take; `otpRequestSchema` in `apps/web` accepts
 * `z.enum(["email"])` and `z.enum(["registration"])` and rejects the rest with
 * a 400 — and each rejected call still spends one of the five attempts the
 * route allows per fifteen minutes. Password reset is a *link*, not an OTP:
 * see `forgotPassword` below.
 *
 * `devCode` is returned by the server outside production so the flow can be
 * completed on a device without waiting on mail delivery.
 */
export async function requestOtp(input: {
  channel: "email";
  identifier: string;
  purpose: "registration";
}) {
  const response = await publicApi.post<
    ApiEnvelope<{
      challengeId: string;
      delivery: unknown;
      devCode?: string;
      expiresAt: string;
    }>
  >("/auth/otp/request", input);

  return unwrap(response);
}

export async function verifyOtp(challengeId: string, code: string) {
  const response = await publicApi.post<
    ApiEnvelope<{ challengeId: string; verifiedAt: string }>
  >("/auth/otp/verify", { challengeId, code });

  return unwrap(response);
}

/**
 * Creates the account, once its OTP challenge has been verified.
 *
 * No `phone`: `registerSchema` takes email, name, `otpChallengeId` and
 * password, and Zod strips anything else — so a phone number collected here
 * would be silently dropped and the account would look, to its owner, as
 * though it had one. Phone lives on the resident profile, which activation
 * creates.
 *
 * The new account is `PUBLIC_USER`, so it lands in `(browse)`, not a
 * dashboard.
 */
export async function register(input: {
  email: string;
  name: string;
  otpChallengeId: string;
  password: string;
}) {
  const response = await publicApi.post<ApiEnvelope<LoginResult>>("/auth/register", input);

  return unwrap(response);
}

export async function signInWithGoogle(idToken: string) {
  const response = await publicApi.post<ApiEnvelope<LoginResult>>("/auth/google", {
    idToken,
  });

  return unwrap(response);
}

/**
 * Sends the reset link.
 *
 * Rejects with the server's message when no account uses the address (404),
 * the account is switched off (403) or the mail provider refused (502), so a
 * resolved call means a real account was mailed.
 */
export async function forgotPassword(email: string) {
  const response = await publicApi.post<ApiEnvelope<{ requested: boolean }>>(
    "/auth/forgot-password",
    { email },
  );

  return unwrap(response);
}

/**
 * Completes the reset with the token from the emailed link.
 *
 * Does **not** return a session: `resetPasswordWithToken` bumps `tokenVersion`
 * and revokes every session, which is the point — a password reset is what
 * somebody does when they think another person has their account. So the
 * screen sends them to login afterwards rather than signing them in.
 */
export async function resetPassword(input: { newPassword: string; token: string }) {
  const response = await publicApi.post<ApiEnvelope<{ reset: boolean }>>(
    "/auth/reset-password",
    input,
  );

  return unwrap(response);
}

export async function fetchMe() {
  const response = await api.get<ApiEnvelope<{ user: ApiUser }>>("/auth/me");

  return unwrap(response).user;
}

/**
 * Whether a RESIDENT account has redeemed its QR code yet.
 *
 * `/auth/me` cannot answer this — activation lives on the resident profile, not
 * the user record — so the boot gate trusts its cached copy and this refreshes
 * it in the background.
 */
export async function fetchActivationStatus() {
  const response = await api.get<
    ApiEnvelope<{ isActivated: boolean; resident: unknown | null }>
  >("/resident/activation-status");

  return unwrap(response).isActivated;
}

/**
 * Redeem a QR activation code.
 *
 * ## This is an authenticated call
 *
 * The route runs `requireApiPrincipal` before anything else
 * (`api/v1/resident/activate/route.ts`), so it goes through `api`, not
 * `publicApi`. Activation *links an existing account* to a resident profile —
 * it promotes the signed-in user to `RESIDENT`, adds the hostel to their
 * `hostelIds`, and marks the code used. There is no way to redeem a code
 * without first having an account.
 *
 * ## It returns a whole new session
 *
 * `activateResident` ends with `issueSessionForUser(user)`, so the response
 * carries fresh `accessToken`/`refreshToken` plus the *updated* user — the one
 * whose role is now `RESIDENT`. The old access token still names the old role,
 * so the tokens have to be written and the account replaced (`startSession`),
 * not just re-fetched. Logging in again afterwards would be a second session
 * for no reason.
 */
export type ActivationResult = LoginResult & {
  activation: {
    expiresAt: string;
    hostelId: string;
    id: string;
    residentId: string;
    status: string;
    usedAt?: string;
  };
  /** `serializeResidentSummary` — same shape as `ResidentSummary` in resident-api. */
  resident: { fullName: string; hostelId: string; id: string; roomType: string };
};

export async function activateResident(input: {
  code: string;
  /** Feeds the admin's device-fingerprint record on the `QRActivation` row. */
  deviceInfo: Record<string, unknown>;
  sessionInfo: Record<string, unknown>;
}) {
  const response = await api.post<ApiEnvelope<ActivationResult>>(
    "/resident/activate",
    input,
  );

  return unwrap(response);
}

export async function logout(refreshToken: string) {
  await publicApi.post("/auth/logout", { refreshToken }).catch(() => {
    // A failed revoke must not trap the user in a session they asked to leave.
    // The local tokens are cleared regardless; the server session expires on
    // its own TTL.
  });
}
