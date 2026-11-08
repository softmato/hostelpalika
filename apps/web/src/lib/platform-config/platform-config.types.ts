import type { ComparisonRow } from "@hostel/shared/email/templates/layout";
import type { SiteConfig } from "@/lib/platform-config/site-config.validation";

export type PendingSettingChange = {
  expiresAt: string;
  id: string;
  key: string;
  label: string;
  rows: ComparisonRow[];
  sentTo: string;
};

export type PlatformStat = { label: string; value: number };

/** `GET /api/v1/public/site-config` (`getPublicSiteConfig`): read by every page and the phone. */
export type PublicSiteConfig = Pick<
  SiteConfig,
  | "announcement"
  | "apps"
  | "content"
  | "facilities"
  | "features"
  | "hero"
  | "identity"
  | "legal"
  | "lifetime"
  | "locations"
  | "plans"
  | "questionCall"
  | "seo"
  | "social"
  | "stats"
  | "trustPoints"
> & {
  appNotice: SiteConfig["appNotice"] | null;
  leaveHold: { max: number; min: number } | null;
  platformStats: PlatformStat[];
  /** Free trial length for new hostels (operations config), shown on Plans & Pricing. */
  trialDays: number;
};
