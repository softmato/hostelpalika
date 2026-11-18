import { webManifest } from "@/lib/web-manifest";

/**
 * `/manifest.webmanifest` for a laptop or desktop. Phones never reach this file:
 * next.config.ts rewrites the same URL by user agent to `/manifest-iphone.webmanifest`
 * or `/manifest-android.webmanifest` (see lib/web-manifest.ts for what differs).
 */
export default function manifest() {
  return webManifest("desktop");
}
