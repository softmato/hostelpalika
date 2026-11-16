/**
 * Which focused screens are showing a saved copy because the phone is offline,
 * and since when. `use-resource` registers here while its screen is focused;
 * `components/offline-stamp` draws the time as "Offline · Updated hh:mm".
 *
 * One stamp for the whole app rather than one per screen: every cached screen
 * gets it, including ones written after this, with nothing to remember.
 *
 * The time is the oldest copy shown **since the phone went offline**, and it
 * only moves back when the network returns. Following whichever screen is
 * focused made it jump 9:07 → 9:21 → 9:22 between tabs (owner, 2026-11-16).
 */

const shown = new Map<symbol, number>();
const listeners = new Set<() => void>();
const onlineListeners = new Set<() => void>();
/** Reads that failed offline with nothing saved: no chip, but the probe must run. */
const failing = new Set<symbol>();
let offline = false;
let stretchOldest: number | null = null;
let oldest: number | null = null;

function emit() {
  if (shown.size > 0) {
    const now = Math.min(...shown.values());
    stretchOldest = stretchOldest === null ? now : Math.min(stretchOldest, now);
  }
  oldest = shown.size > 0 ? stretchOldest : null;
  offline = shown.size > 0 || failing.size > 0;
  for (const listener of listeners) listener();
}

export function showSavedCopy(storedAt: number) {
  const id = Symbol("saved-copy");
  shown.set(id, storedAt);
  emit();
  return () => {
    shown.delete(id);
    emit();
  };
}

export function subscribeSavedCopy(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function oldestSavedCopy() {
  return oldest;
}

/** A read failed offline and has nothing saved to show: keep asking until it can retry. */
export function markOfflineFailure() {
  const id = Symbol("offline-failure");
  failing.add(id);
  emit();
  return () => {
    failing.delete(id);
    emit();
  };
}

/** True while any screen is on a saved copy or failed offline. */
export function isOffline() {
  return offline;
}

/** The server answered again: every screen on a saved copy refetches, the stretch ends. */
export function announceOnline() {
  stretchOldest = null;
  for (const listener of onlineListeners) listener();
}

export function subscribeOnline(listener: () => void) {
  onlineListeners.add(listener);
  return () => {
    onlineListeners.delete(listener);
  };
}
