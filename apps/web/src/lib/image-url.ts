/**
 * A remote photo through Next's optimizer: resized to `width`, re-encoded to
 * WebP/AVIF and served with a long cache life. Hostel originals are phone shots
 * straight from R2 with no Cache-Control, so a card used to pull the full file
 * and re-fetch it on every back navigation (the white-then-photo flash).
 *
 * `width` must be one of Next's image sizes (384, 640, 1200 used here); hosts
 * outside `NEXT_PUBLIC_IMAGE_HOSTS` (next.config) are returned untouched.
 * Relative `/api/v1/files/…/url` photos are 302s to R2: the optimizer follows
 * them once made absolute against the deployed origin. Locally that origin is
 * localhost, which the optimizer refuses, so they pass through as they are.
 */
const HOSTS = (process.env.NEXT_PUBLIC_IMAGE_HOSTS ?? "").split(",").filter(Boolean);
const ORIGIN = process.env.NEXT_PUBLIC_APP_URL?.startsWith("https://")
  ? process.env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")
  : null;

export function optimizedImage(url: string | undefined, width: 384 | 640 | 1200) {
  if (!url) return "";
  const absolute = url.startsWith("/api/") && ORIGIN ? `${ORIGIN}${url}` : url;
  try {
    if (!HOSTS.includes(new URL(absolute).hostname)) return url;
  } catch {
    return url;
  }
  return `/_next/image?url=${encodeURIComponent(absolute)}&w=${width}&q=75`;
}
