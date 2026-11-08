import { cache } from "react";

import type { PublicSiteConfig } from "@/lib/platform-config/platform-config.types";
import { DEFAULT_SITE_CONFIG } from "@/lib/platform-config/site-config.defaults";
import { serverApi } from "@/lib/server-api";

/**
 * Server-side reader for the platform owner's website configuration
 * (`GET /api/v1/public/site-config`), shared by the root layout, its metadata,
 * and the public layout. Wrapped in React's `cache` so all of those resolve from
 * a single API read per request.
 *
 * Nothing here may throw: the whole app — marketing site and portals alike —
 * renders its branding from this, so an unreachable API must degrade to the
 * shipped defaults rather than 500 every route.
 */
export const loadSiteConfig = cache(async (): Promise<PublicSiteConfig> => {
  try {
    return (await serverApi<{ config: PublicSiteConfig }>("/api/v1/public/site-config")).config;
  } catch {
    return {
      ...DEFAULT_SITE_CONFIG,
      facilities: DEFAULT_SITE_CONFIG.facilities.filter((facility) => facility.enabled),
      leaveHold: null,
      locations: DEFAULT_SITE_CONFIG.locations.filter((location) => location.enabled),
      platformStats: [],
      trialDays: 15, // operationsConfigSchema default
    };
  }
});

/** The admin-configured site name, with the shipped default as last resort. */
export async function loadSiteName() {
  const config = await loadSiteConfig();

  return config.identity.siteName || DEFAULT_SITE_CONFIG.identity.siteName;
}
