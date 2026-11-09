import { SITE_URL } from "@/lib/site-url";

/**
 * Making a stored image URL loadable on a phone.
 *
 * ## Why this is needed at all
 *
 * Hostel photo URLs are stored **relative** — `/api/v1/files/<id>/url` — and
 * that is deliberate: commit `827a52c` stripped the origin because the uploader
 * had been baking `window.location.origin` into the database, so photos
 * uploaded from a dev machine pointed every visitor's browser at
 * `http://localhost:3000`. A relative path resolves against whatever origin
 * serves the page, which makes one row correct on localhost, on vercel.app and
 * on a custom domain.
 *
 * **A phone has no page origin.** `<Image source={{ uri: "/api/v1/files/…" }}>`
 * has nothing to resolve against, so it fails — and it fails *silently*, which
 * is why this looked like "images don't work" rather than an error. The fix
 * belongs here, on the client that lacks the origin, not in the database.
 *
 * ## Absolute URLs are left alone
 *
 * The demo hostels carry `images.unsplash.com` photos with no `fileAssetId`.
 * Prefixing those would produce `http://192.168.1.14:3000https://images…` and
 * break the one set of images that currently works.
 *
 * ## No auth header is needed for these
 *
 * `files/[assetId]/url` 302-redirects a `PUBLIC` asset straight to the R2
 * public URL without looking at a principal, so a bare `<Image>` follows the
 * redirect and loads. Private assets — payment proofs, food photos — are a
 * different path: they need a bearer token, which is why `assetUrl()` in
 * `lib/uploads.ts` is paired with `headers` at those call sites. Do not route
 * private assets through here and expect them to load.
 */

/** Anything a phone can already load: an absolute URL, or inline data. */
const SELF_CONTAINED = /^(?:[a-z][a-z\d+\-.]*:)?\/\/|^data:|^file:/i;

/**
 * Resolves a stored image URL against the API origin.
 *
 * Returns `null` for an absent or blank URL, so a caller can branch on "no
 * photo" instead of rendering an `<Image>` pointed at the origin's root — which
 * would fetch the whole HTML homepage and decode it as an image.
 *
 * @param baseUrl The API origin (`API_BASE_URL`), with no trailing slash and no
 *   `/api/v1` suffix — the stored path already carries its own prefix.
 */
export function absoluteMediaUrl(
  url: string | null | undefined,
  baseUrl: string,
): string | null {
  if (!url) {
    return null;
  }

  const trimmed = url.trim();

  if (!trimmed) {
    return null;
  }

  if (SELF_CONTAINED.test(trimmed)) {
    return trimmed;
  }

  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  // `/api/…` is the API (Go); anything else relative is one of the website's own files.
  const base = (path.startsWith("/api/") ? baseUrl : SITE_URL).replace(/\/+$/, "");

  return `${base}${path}`;
}
