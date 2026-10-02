import type { MetadataRoute } from "next";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

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
 * where the app's own sheet walks through Add to Home Screen. When the Play
 * listing is live, add it under `related_applications` as well.
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
    scope: "/app",
    share_target: {
      action: "/app/share-payment",
      method: "POST",
      enctype: "multipart/form-data",
      params: { files: [{ name: "receipt", accept: ["image/*", "application/pdf"] }] },
    },
    short_name: PLATFORM_NAME,
    start_url: "/app",
    // The app's own background, not the brand green: Android paints the status
    // bar and the navigation bar under the tab bar in this colour.
    theme_color: "#ffffff",
  };
}
