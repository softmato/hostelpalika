/**
 * The fingerprint lock — whether the portal may be seen right now.
 *
 * ## Locked until proven otherwise
 *
 * `locked` starts `true` in every process, and whether the lock *shows* is the
 * account's setting (`auth.biometricUserId`), which redux-persist has already
 * rehydrated before the first portal frame. So a cold start is decided
 * synchronously: there is no async read in between during which a dashboard
 * could paint. It also locks the moment the app goes to the background, so the
 * frame waiting there when it comes back is the lock, never the portal.
 *
 * ## The grace
 *
 * Picking a photo, signing a payment in eSewa or reading the code email all
 * background the app. Coming back within `GRACE_MS` lifts the lock without
 * asking; longer, and it asks.
 *
 * ## Why a SecureStore item and not just `authenticateAsync`
 *
 * Reading `LOCK_KEY` *is* the fingerprint check, and the key is bound to the
 * phone's current fingerprints: Android drops it the moment one is added or
 * removed, iOS stores it `biometryCurrentSet`. So `null` means "someone changed
 * the fingers on this phone", which a bare prompt cannot tell from a wrong
 * finger — and that is when the email code (the account's Gmail) is asked for.
 */

import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";

import { api } from "@/lib/api";
import { type ApiEnvelope, unwrap } from "@/lib/api-contract";
import type { ApiUser } from "@/lib/auth-api";
import { ROLE } from "@/constants/roles";

const GRACE_MS = 30_000;

const LOCK_KEY = "hh_app_lock";

let locked = true;
let backgroundedAt: number | null = null;
/** A system fingerprint sheet can pause the activity on some phones; that is not leaving. */
let authenticating = false;
const listeners = new Set<() => void>();

function emit(next: boolean) {
  if (locked === next) return;
  locked = next;
  for (const listener of listeners) listener();
}

export function subscribeToLock(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function isLocked() {
  return locked;
}

export function unlockApp() {
  emit(false);
}

/** Wired to `AppState` once, by the lock host. */
export function onAppStateChange(state: string) {
  if (authenticating) return;

  if (state === "background") {
    // Already locked when it left means it was never opened — no grace for that.
    backgroundedAt = locked ? null : Date.now();
    emit(true);
    return;
  }

  if (state === "active" && backgroundedAt !== null) {
    const quick = Date.now() - backgroundedAt < GRACE_MS;
    backgroundedAt = null;
    if (quick) emit(false);
  }
}

/**
 * Owner, warden and resident portals with an email; a cook only where the
 * owner switched it on (`cookFingerprintLock`, which turning off also lifts an
 * already-enabled cook's lock).
 */
export function canOfferLock(account: ApiUser | null) {
  if (!account?.email) return false;
  if (account.role === ROLE.COOK) return account.cookFingerprintLock === true;
  return (
    account.role === ROLE.HOSTEL_ADMIN ||
    account.role === ROLE.WARDEN ||
    account.role === ROLE.RESIDENT
  );
}

/**
 * Whether the email code can reach this account. A minted cook login
 * (`sunr@cook.local`, apps/web `COOK_LOGIN_DOMAIN`) is a username, not an
 * inbox — those cooks recover by signing in again with their password.
 */
export function hasMailbox(account: ApiUser | null): account is ApiUser & { email: string } {
  return Boolean(account?.email && !account.email.endsWith("@cook.local"));
}

/** True while a fingerprint sheet is up — its pause/resume is not the app leaving. */
export function isAuthenticating() {
  return authenticating;
}

export type FingerprintStatus = "ready" | "weak" | "none";

/**
 * `ready`: a strong biometric is enrolled — what SecureStore's auth-bound keys
 * require. `weak`: only a weak one (often face unlock), which cannot hold the
 * key. `none`: nothing saved on the phone yet.
 */
export async function fingerprintStatus(): Promise<FingerprintStatus> {
  const level = await LocalAuthentication.getEnrolledLevelAsync().catch(
    () => LocalAuthentication.SecurityLevel.NONE,
  );
  if (level >= LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG) return "ready";
  return level === LocalAuthentication.SecurityLevel.BIOMETRIC_WEAK ? "weak" : "none";
}

export async function hasFingerprint() {
  return (await fingerprintStatus()) === "ready";
}

async function withPrompt<T>(work: () => Promise<T>) {
  authenticating = true;
  try {
    return await work();
  } finally {
    authenticating = false;
  }
}

/** Creates the fingerprint-bound key; the prompt it shows is the confirmation. */
export async function armFingerprint() {
  return withPrompt(() =>
    SecureStore.setItemAsync(LOCK_KEY, String(Date.now()), {
      authenticationPrompt: "Confirm your fingerprint",
      requireAuthentication: true,
    }),
  )
    .then(() => true)
    .catch(() => false);
}

export async function disarmFingerprint() {
  await SecureStore.deleteItemAsync(LOCK_KEY, { requireAuthentication: true }).catch(() => {});
}

export type FingerprintResult = "unlocked" | "changed" | "failed";

export async function unlockWithFingerprint(): Promise<FingerprintResult> {
  if (!(await hasFingerprint())) return "changed";

  try {
    const value = await withPrompt(() =>
      SecureStore.getItemAsync(LOCK_KEY, {
        authenticationPrompt: "Unlock HostelPalika",
        requireAuthentication: true,
      }),
    );
    if (!value) return "changed";
    emit(false);
    return "unlocked";
  } catch {
    // Cancelled, not recognised, or locked out for too many tries.
    return "failed";
  }
}

/** Mails the signed-in account's own address a code. */
export async function sendLockCode() {
  const response = await api.post<
    ApiEnvelope<{ challengeId: string; devCode?: string; expiresAt: string }>
  >("/auth/biometric/code");
  return unwrap(response);
}

export async function verifyLockCode(challengeId: string, code: string) {
  const response = await api.post<ApiEnvelope<{ verified: boolean }>>("/auth/biometric/verify", {
    challengeId,
    code,
  });
  return unwrap(response);
}

/** `s••••t@gmail.com` — enough to recognise, not enough to harvest. */
export function maskEmail(email: string) {
  const [name, domain] = email.split("@");
  if (!domain || name.length < 2) return email;
  return `${name[0]}${"•".repeat(Math.min(name.length - 2, 6))}${name.at(-1)}@${domain}`;
}
