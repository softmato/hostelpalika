/**
 * Which focused screens are showing a saved copy because the phone is offline,
 * and since when. `use-resource` registers here while its screen is focused;
 * `components/offline-stamp` draws the oldest time as "Offline · Updated hh:mm".
 *
 * One stamp for the whole app rather than one per screen: every cached screen
 * gets it, including ones written after this, with nothing to remember.
 */

const shown = new Map<symbol, number>();
const listeners = new Set<() => void>();
let oldest: number | null = null;

function emit() {
  oldest = shown.size > 0 ? Math.min(...shown.values()) : null;
  for (const listener of listeners) listener();
}

/** Returns the un-register. */
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
