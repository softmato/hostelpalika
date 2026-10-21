import { cache } from "react";

import { DEFAULT_SITE_CONFIG } from "@/modules/platform-config/site-config.defaults";
import {
  getPublicSiteConfig,
  type PublicSiteConfig,
} from "@/modules/platform-config/site-config.service";

/**
 * Server-side reader for the platform owner's website configuration, shared by
 * the root layout, its metadata, and the public layout. Wrapped in React's
 * `cache` so all of those resolve from a single database read per request.
 *
 * Nothing here may throw: the whole app — marketing site and portals alike —
 * renders its branding from this, so an unreachable settings collection must
 * degrade to the shipped defaults rather than 500 every route.
 */
export const loadSiteConfig = cache(async (): Promise<PublicSiteConfig> => {
  try {
    return await getPublicSiteConfig();
  } catch {
    return {
      ...DEFAULT_SITE_CONFIG,
      facilities: DEFAULT_SITE_CONFIG.facilities.filter((facility) => facility.enabled),
      leaveHold: null,
      locations: DEFAULT_SITE_CONFIG.locations.filter((location) => location.enabled),
      platformStats: [],
    };
  }
});

/** The admin-configured site name, with the shipped default as last resort. */
export async function loadSiteName() {
  const config = await loadSiteConfig();

  return config.identity.siteName || DEFAULT_SITE_CONFIG.identity.siteName;
}
