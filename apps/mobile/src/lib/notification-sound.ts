/**
 * Which arrival of a notification gets to make the sound, while the app is open.
 *
 * A notification can reach an open app twice: over the socket (`use-realtime`)
 * and as a push the OS hands to `setNotificationHandler`. The socket nearly
 * always lands first — one hop to the push's three — but not always, and the
 * push may never come at all: permission not granted, quiet hours, a category
 * switched off, a delivery that failed. So neither route can own the sound.
 * Whichever arrives first claims the notification's id and sounds; the other
 * finds the claim and stays quiet.
 *
 * Free of React Native imports so vitest can run it. The playing itself is in
 * `lib/sound-effects.ts`.
 */

/**
 * Long enough to cover a push FCM held back under Doze; short enough that a
 * batched row updated later ("5 people reacted") sounds again.
 */
export const CLAIM_TTL_MS = 5 * 60_000;

const claims = new Map<string, number>();

/**
 * True when the caller should sound: nothing has, for this id, recently.
 *
 * An id-less notification — a local one, or a push from a server that predates
 * this — cannot be matched with a twin, so it always sounds. A second chime is a
 * better failure than a silent one.
 */
export function claimNotificationSound(id: unknown, now = Date.now()): boolean {
  for (const [key, claimedAt] of claims) {
    if (now - claimedAt >= CLAIM_TTL_MS) {
      claims.delete(key);
    }
  }

  if (typeof id !== "string" || id === "") {
    return true;
  }

  if (claims.has(id)) {
    return false;
  }

  claims.set(id, now);

  return true;
}

/** Tests only: forget every claim. */
export function resetNotificationSoundClaims() {
  claims.clear();
}

const displays = new Map<string, number>();

/**
 * The same first-one-wins claim as {@link claimNotificationSound}, for the
 * **banner** rather than the chime: a notification row reaches an open app twice
 * — over the socket (`useRealtime`, drawn as a local notification) and as its
 * push — and only the first of the two may be shown. Keyed on the row id, or
 * `campaign:{id}` for a broadcast.
 */
export function claimNotificationDisplay(id: unknown, now = Date.now()): boolean {
  for (const [key, claimedAt] of displays) {
    if (now - claimedAt >= CLAIM_TTL_MS) {
      displays.delete(key);
    }
  }

  if (typeof id !== "string" || id === "") {
    return true;
  }

  if (displays.has(id)) {
    return false;
  }

  displays.set(id, now);

  return true;
}
