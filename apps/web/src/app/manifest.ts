import type { MetadataRoute } from "next";

import { PLATFORM_NAME, PLATFORM_PLAY_STORE_URL } from "@hostel/shared/brand/brand";

const PLATFORM_PLAY_STORE_ID = new URL(PLATFORM_PLAY_STORE_URL).searchParams.get("id") ?? undefined;

import { loadSeo, resolveSeoPage } from "@/lib/seo-config";

/**
 * The web app manifest: the name, icons and colour a browser uses for the site.
 *
 * What gets installed is the phone app itself, exported for the web and served
 * at `/app` (`apps/mobile/scripts/export-pwa.mjs`) — the same screens as the
 * Android build, not the website in a window. So `start_url`, `scope` and `id`
 * all point there, and installing from any page of the site installs the app.
 * No trailing slash on `scope` or `start_url`: Next redirects `/app/` to `/app`,
 * and `/app` is outside a `/app/` scope, so Chrome drew its "left the app" bar
 * over the home screen. `id` keeps the slash so existing installs update.
 * `InstallAppBanner` fires Android's install prompt and sends iPhones to `/app`,
 * where the app's own sheet walks through Add to Home Screen. On Android,
 * `prefer_related_applications` makes Chrome offer the Play app instead of
 * installing this one; iPhones and desktops still install `/app`.
 */
export default async function manifest(): Promise<MetadataRoute.Manifest> {
  const { fill, seo } = await loadSeo();
  const home = resolveSeoPage(seo, "home", fill);

  return {
    background_color: "#ffffff",
    categories: ["business", "education", "lifestyle"],
    description: home.description,
    display: "standalone",
    id: "/app/",
    icons: [
      { sizes: "512x512", src: "/icon.png", type: "image/png" },
      { sizes: "180x180", src: "/apple-icon.png", type: "image/png" },
    ],
    lang: "en-NP",
    name: PLATFORM_NAME,
    prefer_related_applications: true,
    related_applications: [
      { id: PLATFORM_PLAY_STORE_ID, platform: "play", url: PLATFORM_PLAY_STORE_URL },
    ],
    scope: "/app",
    share_target: {
      action: "/app/share-payment",
      method: "POST",
      enctype: "multipart/form-data",
      // Android can advertise a banking PDF as generic binary or x-pdf.
      // Include extensions too, otherwise Chrome can omit the attachment.
      params: { files: [{ name: "receipt", accept: ["image/*", "application/pdf", "application/x-pdf", "application/octet-stream", "binary/octet-stream", ".pdf", ".jpg", ".jpeg", ".png", ".webp", ".heic", ".heif"] }] },
    },
    short_name: PLATFORM_NAME,
    start_url: "/app",
    // The app's own background, not the brand green: Android paints the status
    // bar and the navigation bar under the tab bar in this colour.
    theme_color: "#ffffff",
  };
}
