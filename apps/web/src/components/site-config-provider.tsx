"use client";

import { createContext, useContext, type ReactNode } from "react";

import { DEFAULT_SITE_CONFIG } from "@/modules/platform-config/site-config.defaults";
import type { PublicSiteConfig } from "@/modules/platform-config/site-config.service";

export type { PublicSiteConfig };

/**
 * Platform-owner-editable website content, fetched once on the server in the
 * public layout and handed to client components below it. Falls back to the
 * shipped defaults so a component rendered outside the provider (or a page that
 * renders before the config resolves) still has something sensible to show.
 */
const FALLBACK: PublicSiteConfig = {
  announcement: DEFAULT_SITE_CONFIG.announcement,
  apps: DEFAULT_SITE_CONFIG.apps,
  content: DEFAULT_SITE_CONFIG.content,
  facilities: DEFAULT_SITE_CONFIG.facilities,
  platformStats: [],
  features: DEFAULT_SITE_CONFIG.features,
  hero: DEFAULT_SITE_CONFIG.hero,
  identity: DEFAULT_SITE_CONFIG.identity,
  legal: DEFAULT_SITE_CONFIG.legal,
  lifetime: DEFAULT_SITE_CONFIG.lifetime,
  locations: DEFAULT_SITE_CONFIG.locations,
  plans: DEFAULT_SITE_CONFIG.plans,
  questionCall: DEFAULT_SITE_CONFIG.questionCall,
  seo: DEFAULT_SITE_CONFIG.seo,
  social: DEFAULT_SITE_CONFIG.social,
  stats: DEFAULT_SITE_CONFIG.stats,
  trustPoints: DEFAULT_SITE_CONFIG.trustPoints,
};

const SiteConfigContext = createContext<PublicSiteConfig>(FALLBACK);

export function SiteConfigProvider({
  children,
  config,
}: {
  children: ReactNode;
  config: PublicSiteConfig;
}) {
  return (
    <SiteConfigContext.Provider value={config}>{children}</SiteConfigContext.Provider>
  );
}

export function useSiteConfig() {
  return useContext(SiteConfigContext);
}

/**
 * The owner-configured platform name as a drop-in JSX node, for the many spots
 * that only need the word and would otherwise each grow a hook.
 */
export function SiteName() {
  return <>{useSiteConfig().identity.siteName}</>;
}

/** Convenience reader for the most common check — a single feature flag. */
export function useFeatureFlag(flag: keyof PublicSiteConfig["features"]) {
  return useSiteConfig().features[flag];
}
