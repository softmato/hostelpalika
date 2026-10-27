/**
 * The lock PIN, checkable without a network.
 *
 * The server is the authority (`/auth/lock-pin/verify`, ten wrong in a row
 * blocks it). This keeps a salted PBKDF2 hash of the last PIN the server
 * accepted — after a verify or a save — in SecureStore, so an owner in a dead
 * zone can still open the app. Offline only: online, the server answers and a
 * PIN changed on another phone (a wrong answer for the PIN this copy holds)
 * deletes the copy.
 *
 * Offline wrong tries are limited here: five free, then a wait that doubles
 * with each further miss, held in the same record so a relaunch does not reset
 * it. A four-digit PIN is a small space, so the hash is a second wall — the
 * first is SecureStore's Keystore encryption.
 */

import { pbkdf2Async } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import * as SecureStore from "expo-secure-store";

const KEY = "hh_lock_pin_local";
// ponytail: tuned for a budget Redmi (~1s); raise once a device run shows the time.
export const PIN_ITERATIONS = 20_000;
export const FREE_TRIES = 5;
const FIRST_WAIT_MS = 60_000;
const MAX_WAIT_MS = 60 * 60_000;

type LocalPin = {
  accountId: string;
  fails: number;
  hash: string;
  iterations: number;
  salt: string;
  /** Wall-clock ms before which no offline try is taken. */
  until: number;
};

async function readRecord(): Promise<LocalPin | null> {
  try {
    const raw = await SecureStore.getItemAsync(KEY);
    return raw ? (JSON.parse(raw) as LocalPin) : null;
  } catch {
    return null;
  }
}

async function writeRecord(record: LocalPin) {
  await SecureStore.setItemAsync(KEY, JSON.stringify(record)).catch(() => {});
}

async function hashPin(pin: string, salt: string, iterations: number) {
  return bytesToHex(await pbkdf2Async(sha256, pin, salt, { c: iterations, dkLen: 32 }));
}

function saltBytes() {
  try {
    return randomBytes(16);
  } catch {
    // No `crypto.getRandomValues` on this runtime. A salt only has to be
    // unique, not secret.
    return Uint8Array.from({ length: 16 }, () => Math.floor(Math.random() * 256));
  }
}

/** After the server accepted `pin` (a verify or a save). */
export async function rememberPin(accountId: string, pin: string) {
  const salt = bytesToHex(saltBytes());
  const hash = await hashPin(pin, salt, PIN_ITERATIONS);
  await writeRecord({ accountId, fails: 0, hash, iterations: PIN_ITERATIONS, salt, until: 0 });
}

export async function forgetPin() {
  await SecureStore.deleteItemAsync(KEY).catch(() => {});
}

/** The server refused `pin`: if this copy still accepts it, the PIN was changed elsewhere. */
export async function forgetIfStale(accountId: string, pin: string) {
  const record = await readRecord();
  if (!record || record.accountId !== accountId) return;
  if ((await hashPin(pin, record.salt, record.iterations)) === record.hash) await forgetPin();
}

export type OfflineCheck =
  | { ok: true }
  | { ok: false; reason: "none" }
  | { ok: false; reason: "wrong"; triesLeft: number }
  | { ok: false; reason: "wait"; until: number };

/** Offline only. `none` = no copy for this account; the caller reports offline. */
export async function checkPinOffline(
  accountId: string,
  pin: string,
  now = Date.now(),
): Promise<OfflineCheck> {
  const record = await readRecord();
  if (!record || record.accountId !== accountId) return { ok: false, reason: "none" };
  if (record.until > now) return { ok: false, reason: "wait", until: record.until };

  if ((await hashPin(pin, record.salt, record.iterations)) === record.hash) {
    if (record.fails > 0) await writeRecord({ ...record, fails: 0, until: 0 });
    return { ok: true };
  }

  const fails = record.fails + 1;
  const over = fails - FREE_TRIES;
  const until = over >= 0 ? now + Math.min(FIRST_WAIT_MS * 2 ** over, MAX_WAIT_MS) : 0;
  await writeRecord({ ...record, fails, until });

  return until > 0
    ? { ok: false, reason: "wait", until }
    : { ok: false, reason: "wrong", triesLeft: FREE_TRIES - fails };
}
