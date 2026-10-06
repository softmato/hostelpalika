/** `"1.10.0"` is newer than `"1.9.2"` — dotted numbers, compared part by part. */
export function isNewerVersion(candidate: string, installed: string | null) {
  if (!installed) return false;
  const a = candidate.split(".").map(Number);
  const b = installed.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] || 0) - (b[i] || 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/**
 * iOS has no Play-style in-app update API, so the App Store's public lookup
 * says which version is live. Asked in the storefronts the app is sold in.
 * Answers the store page to open, or `null` when this install is current.
 *
 * Not yet run against a live listing — the app is not on the App Store. Verify
 * on the first release: docs/MOBILE_APP_PHASES.md, M10.
 */
export async function appStoreUpdateUrl(bundleId: string, installed: string | null) {
  // Must name every storefront the app is sold in, or no sheet ever shows there.
  for (const country of ["np", "in"]) {
    const response = await fetch(
      `https://itunes.apple.com/lookup?bundleId=${bundleId}&country=${country}`,
    ).catch(() => null);
    const live = (await response?.json().catch(() => null))?.results?.[0] as
      | { trackViewUrl?: string; version?: string }
      | undefined;
    if (live?.version && live.trackViewUrl) {
      return isNewerVersion(live.version, installed) ? live.trackViewUrl : null;
    }
  }
  return null;
}
