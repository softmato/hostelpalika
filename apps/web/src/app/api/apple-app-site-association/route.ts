/**
 * Apple App Site Association — the iOS half of app links.
 *
 * Served at `/.well-known/apple-app-site-association` by a rewrite in
 * `next.config.ts`, because Next's app router does not route folders whose name
 * begins with a dot. The public path is the one Apple fetches and the only one
 * that matters; this file's own location under `/api` is an implementation
 * detail of that rewrite.
 *
 * ## Why this is a route and `assetlinks.json` is a static file
 *
 * They are counterparts — Android's is committed under `public/.well-known/`
 * with a README explaining the fingerprint in it — and the difference is not a
 * change of mind. Android's file names a **signing certificate**, which we hold
 * and can read out of the keystore today. This one names an **Apple Team ID**,
 * which Apple issues with the developer account and which does not exist yet.
 *
 * A committed placeholder would be the worse failure. iOS fetches this once,
 * around install, through Apple's CDN, and caches the answer; a file naming the
 * wrong app outlives the deploy that corrects it, and it fails silently — links
 * simply keep opening Safari, with nothing anywhere saying why. A 404 is the
 * honest answer to "does this domain claim an iOS app", and it is what iOS
 * already gets today.
 *
 * So: unset `APPLE_APP_ID_PREFIX` answers 404, iOS never claims the domain, and
 * behaviour is exactly what it is now. Set it — Apple Developer → Membership,
 * as `<Team ID>.com.softmato.hostelpalika` — and universal links begin working on
 * the next install. No app release and no rebuild: this is server state, like
 * the Android fingerprint, and `associatedDomains` in `apps/mobile/app.json` is
 * already the other half.
 *
 * ## The paths
 *
 * They mirror `android.intentFilters` in `apps/mobile/app.json` exactly, and
 * have to keep mirroring it — a link the app claims on one platform and not the
 * other is the kind of difference nobody notices until a user reports that
 * "sharing works on my phone but not hers".
 *
 * `*` is Apple's wildcard for a path segment tail, so `/ref/*` is the same
 * claim as Android's `pathPrefix: "/ref/"`, and `/community/*` likewise. The
 * rest are exact.
 */

const APP_LINK_COMPONENTS = [
  { "/": "/ref/*", comment: "Referral links — see lib/referral-link.ts" },
  { "/": "/inquiry", comment: "Referred inquiry form" },
  { "/": "/guardian-invite", comment: "Guardian invitation" },
  { "/": "/cook-invite", comment: "Cook invitation" },
  { "/": "/community/*", comment: "Shared community post" },
  { "/": "/join/*", comment: "Hostel join link — residents add themselves" },
];

export function GET() {
  const appId = process.env.APPLE_APP_ID_PREFIX;

  if (!appId) {
    return new Response("Not Found", {
      headers: { "content-type": "text/plain" },
      status: 404,
    });
  }

  return new Response(
    JSON.stringify({
      applinks: {
        details: [{ appIDs: [appId], components: APP_LINK_COMPONENTS }],
      },
    }),
    {
      headers: {
        /*
         * An hour, not a day. Apple's CDN is the real cache and honours its own
         * schedule regardless; this only governs how quickly a correction to
         * the team id reaches a client that asks us directly.
         */
        "cache-control": "public, max-age=3600",
        /*
         * `application/json` and no redirect are both requirements, not
         * preferences: iOS refuses an AASA served as anything else and does not
         * follow a redirect to find one. The rewrite in `next.config.ts` is a
         * rewrite rather than a redirect for that second reason.
         */
        "content-type": "application/json",
      },
      status: 200,
    },
  );
}
