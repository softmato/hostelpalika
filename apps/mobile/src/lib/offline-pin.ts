/**
 * The lock PIN, checkable without a network.
 *
 * The server is the authority (`/auth/lock-pin/verify`, ten wrong in a row
 * blocks it). This keeps a salted PBKDF2 hash of the last PIN the server
 * accepted — after a verify or a save — in SecureStore. It is checked first,
 * online too (`matchesPin`): a match opens the app with no network wait and the
 * server confirms behind it; a PIN changed on another phone, or a blocked one,
 * is refused there, which deletes the copy and locks the app again.
 *
 * Offline wrong tries are limited here: five free, then a wait that doubles
 * with each further miss, held in the same record so a relaunch does not reset
 * it.
 *
 * ## One round, not twenty thousand
 *
 * The hash was PBKDF2 at 20k rounds, in plain JS on the JS thread. On a budget
 * Redmi that held the thread for seconds — after every wrong PIN (keypad dead)
 * and three seconds after every right one (Home dead) — field video,
 * 2026-10-27. And it bought nothing: a PIN is one of 10,000, so whoever lifts
 * this record out of the Keystore tries all of them on a laptop in under a
 * second at any round count a phone can afford. The walls are SecureStore's
 * Keystore encryption and the try limit below; the salted hash only keeps the
 * PIN itself out of the record. Records written at the old count still check
 * with their own `iterations`, and the next online unlock rewrites them.
 */

import { pbkdf2Async } from "@noble/hashes/pbkdf2";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import * as SecureStore from "expo-secure-store";

const KEY = "hh_lock_pin_local";
export const PIN_ITERATIONS = 1;
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

/**
 * The record, read from the Keystore once and then held in memory: a Keystore
 * read costs a budget phone tens of milliseconds, and the unlock is the one
 * place that must not wait. Every write goes through here, so it never drifts.
 */
let held: Promise<LocalPin | null> | null = null;

function readRecord(): Promise<LocalPin | null> {
  held ??= (async () => {
    try {
      const raw = await SecureStore.getItemAsync(KEY);
      return raw ? (JSON.parse(raw) as LocalPin) : null;
    } catch {
      held = null;
      return null;
    }
  })();
  return held;
}

async function writeRecord(record: LocalPin) {
  held = Promise.resolve(record);
  await SecureStore.setItemAsync(KEY, JSON.stringify(record)).catch(() => {});
}

/** The lock screen calls this as it opens, so the first PIN finds the record in memory. */
export function warmPin() {
  void readRecord();
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
  held = Promise.resolve(null);
  await SecureStore.deleteItemAsync(KEY).catch(() => {});
}

/**
 * Online or not: does the copy say yes to `pin`? A yes opens the app at once and
 * the server confirms behind it (`checkLockPin`). A no counts nothing here — the
 * caller asks the server, whose ten-try limit counts it, so a wrong guess is
 * never free. Old-count records answer no: seconds of hashing is the lag this
 * exists to remove.
 */
export async function matchesPin(accountId: string, pin: string) {
  const record = await readRecord();
  if (!record || record.accountId !== accountId || record.iterations !== PIN_ITERATIONS) return false;
  if ((await hashPin(pin, record.salt, record.iterations)) !== record.hash) return false;
  if (record.fails > 0) void writeRecord({ ...record, fails: 0, until: 0 });
  return true;
}

/** The server refused `pin`: if this copy still accepts it, the PIN was changed elsewhere. */
export async function forgetIfStale(accountId: string, pin: string) {
  const record = await readRecord();
  if (!record || record.accountId !== accountId) return;
  // An old-count record is not worth seconds of a frozen keypad to test: drop
  // it, and the next unlock that reaches the server writes a fresh one.
  if (record.iterations !== PIN_ITERATIONS) return forgetPin();
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
