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
 * ## PIN or fingerprint
 *
 * The lock is the account's 4-digit PIN (`hasLockPin`, checked by the server,
 * shared with every web portal); the fingerprint is a per-phone shortcut to
 * the same door (`auth.biometricUserId`). An account from before the PIN that
 * turned on a fingerprint keeps a fingerprint-only lock until it adds one.
 *
 * ## Strong fingerprints hold a key; weak ones get the system prompt
 *
 * On a phone whose fingerprint is Android Class 3 ("strong"), reading
 * `LOCK_KEY` *is* the check, and the key is bound to the current fingerprints:
 * Android drops it the moment one is added or removed, iOS stores it
 * `biometryCurrentSet`. So `null` means "someone changed the fingers on this
 * phone" — and then the PIN (or, with no PIN, the email code) is asked for.
 *
 * Many budget phones register their fingerprint as Class 2 ("weak"), which no
 * keystore key can be bound to. Those get the plain system prompt — what the
 * bank apps use — and the PIN stands behind it.
 */

import * as LocalAuthentication from "expo-local-authentication";
import * as SecureStore from "expo-secure-store";

// The name alone — `constants/branding` also pulls in the logo images.
import { PLATFORM_NAME as APP_NAME } from "@hostel/brand/brand";
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

export function lockApp() {
  emit(true);
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
  // A temporary login was handed out on purpose; the owner's lock is not its to keep.
  if (!account?.email || account.viaTemporaryCredential) return false;
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
 * `ready`: a strong biometric is enrolled — SecureStore's auth-bound key.
 * `weak`: only a Class 2 one — the system prompt. `none`: nothing saved yet.
 */
export async function fingerprintStatus(): Promise<FingerprintStatus> {
  const level = await LocalAuthentication.getEnrolledLevelAsync().catch(
    () => LocalAuthentication.SecurityLevel.NONE,
  );
  if (level >= LocalAuthentication.SecurityLevel.BIOMETRIC_STRONG) return "ready";
  return level === LocalAuthentication.SecurityLevel.BIOMETRIC_WEAK ? "weak" : "none";
}

/** Either kind can open the app. */
export async function hasFingerprint() {
  return (await fingerprintStatus()) !== "none";
}

function promptWeakFingerprint(message: string) {
  return LocalAuthentication.authenticateAsync({
    biometricsSecurityLevel: "weak",
    cancelLabel: "Use PIN",
    disableDeviceFallback: true,
    promptMessage: message,
  });
}

async function withPrompt<T>(work: () => Promise<T>) {
  authenticating = true;
  try {
    return await work();
  } finally {
    authenticating = false;
  }
}

/** Strong: creates the fingerprint-bound key. Weak: one good read. The prompt is the confirmation. */
export async function armFingerprint() {
  const status = await fingerprintStatus();
  if (status === "none") return false;

  if (status === "weak") {
    const result = await withPrompt(() => promptWeakFingerprint("Confirm it's you"));
    return result.success;
  }

  return withPrompt(() =>
    SecureStore.setItemAsync(LOCK_KEY, String(Date.now()), {
      authenticationPrompt: "Confirm it's you",
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
  const status = await fingerprintStatus();
  if (status === "none") return "changed";

  if (status === "weak") {
    const result = await withPrompt(() => promptWeakFingerprint(`Unlock ${APP_NAME}`));
    if (!result.success) return "failed";
    emit(false);
    return "unlocked";
  }

  try {
    const value = await withPrompt(() =>
      SecureStore.getItemAsync(LOCK_KEY, {
        authenticationPrompt: `Unlock ${APP_NAME}`,
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

export type LockPinProof = {
  challengeId?: string;
  code?: string;
  currentPin?: string;
  password?: string;
};

/** Checks the PIN with the server; 10 wrong in a row blocks it until it is reset. */
export async function checkLockPin(pin: string) {
  unwrap(await api.post<ApiEnvelope<{ verified: true }>>("/auth/lock-pin/verify", { pin }));
}

export async function unlockWithPin(pin: string) {
  await checkLockPin(pin);
  emit(false);
}

/** First PIN needs nothing more; replacing one needs `proof`. */
export async function saveLockPin(pin: string, proof: LockPinProof = {}) {
  return unwrap(await api.put<ApiEnvelope<{ hasLockPin: true }>>("/auth/lock-pin", { pin, ...proof }));
}

/** Off for the account — every phone and the website. */
export async function removeLockPin(proof: LockPinProof) {
  return unwrap(
    await api.delete<ApiEnvelope<{ hasLockPin: false }>>("/auth/lock-pin", { data: proof }),
  );
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
