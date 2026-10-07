import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { getPublicPlatformStats } from "@/modules/reports/platform-highlights.service";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { currentBsPeriod } from "@hostel/shared/calendar/bs";
import { sellingCatalog } from "@hostel/shared/plans/catalog";
import { PlatformSettingModel } from "@hostel/db/models/PlatformSetting";

import { DEFAULT_SITE_CONFIG } from "./site-config.defaults";
import {
  isSiteConfigSection,
  siteConfigSectionSchemas,
  SITE_CONFIG_SECTIONS,
  type SiteConfig,
  type SiteConfigSection,
} from "./site-config.validation";

type PlatformSettingRecord = {
  key: string;
  updatedAt?: Date;
  value: unknown;
};

export class SiteConfigServiceError extends Error {
  constructor(
    message: string,
    public errorCode = "SITE_CONFIG_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

/**
 * Stored sections are re-parsed on read rather than trusted: a section written
 * by an older build (or hand-edited in the database) falls back to the shipped
 * default instead of breaking the public page that renders it.
 */
function coerceSection<Section extends SiteConfigSection>(
  section: Section,
  value: unknown,
): SiteConfig[Section] {
  const parsed = siteConfigSectionSchemas[section].safeParse(value);

  if (!parsed.success) {
    return DEFAULT_SITE_CONFIG[section];
  }

  return parsed.data as SiteConfig[Section];
}

/**
 * Every request of every route in every portal reads the site config, so a
 * plain per-request `react.cache` still means one `PlatformSetting.find` per
 * page view. This memo is per Fluid instance, not shared across them, so the
 * hit rate is good rather than guaranteed — which is fine for a read that
 * falls back to a database query on a miss.
 *
 * The window is the staleness a platform admin sees after saving a section on
 * an instance other than the one they are talking to; `invalidateSiteConfigCache`
 * covers the common case of the same instance.
 */
const CACHE_MS = 60 * 1000;

let cachedConfig: { at: number; config: SiteConfig } | null = null;

/** Drops the memo so the next read sees a just-saved section. */
export function invalidateSiteConfigCache() {
  cachedConfig = null;
}

export async function getSiteConfig(): Promise<SiteConfig> {
  if (cachedConfig && Date.now() - cachedConfig.at < CACHE_MS) {
    return cachedConfig.config;
  }

  await connectToDatabase();

  const stored = (await PlatformSettingModel.find({
    key: { $in: SITE_CONFIG_SECTIONS },
  }).lean()) as PlatformSettingRecord[];

  const config = { ...DEFAULT_SITE_CONFIG };

  for (const record of stored) {
    if (!isSiteConfigSection(record.key)) {
      continue;
    }

    // Index signature over a mapped type needs the widening cast; each value is
    // validated by coerceSection immediately above it.
    (config as Record<string, unknown>)[record.key] = coerceSection(
      record.key,
      record.value,
    );
  }

  return config;
}

export async function getSiteConfigSection<Section extends SiteConfigSection>(
  section: Section,
): Promise<SiteConfig[Section]> {
  await connectToDatabase();

  const record = (await PlatformSettingModel.findOne({
    key: section,
  }).lean()) as PlatformSettingRecord | null;

  if (!record) {
    return DEFAULT_SITE_CONFIG[section];
  }

  return coerceSection(section, record.value);
}

export async function updateSiteConfigSection(
  section: string,
  input: unknown,
  principal: ApiPrincipal,
) {
  if (!isSiteConfigSection(section)) {
    throw new SiteConfigServiceError(
      `Unknown site config section "${section}".`,
      "UNKNOWN_SECTION",
      404,
    );
  }

  const parsed = siteConfigSectionSchemas[section].safeParse(input);

  if (!parsed.success) {
    throw new SiteConfigServiceError(
      parsed.error.issues[0]?.message ?? "Invalid site configuration payload.",
      "INVALID_SITE_CONFIG",
      422,
    );
  }

  await connectToDatabase();

  await PlatformSettingModel.findOneAndUpdate(
    { key: section },
    { key: section, updatedBy: principal.userId, value: parsed.data },
    { new: true, setDefaultsOnInsert: true, upsert: true },
  );

  invalidateSiteConfigCache();

  await AuditLogModel.create({
    action: "PLATFORM_SITE_CONFIG_UPDATED",
    actorId: principal.userId,
    entityId: section,
    entityType: "PlatformSetting",
    metadata: { section },
  });

  return { section, value: parsed.data };
}

/**
 * Public projection — the choke point for anything that should stay owner-only.
 *
 * `email` is deliberately absent. It is the only section that is deployment
 * plumbing rather than website content: the sending domain and the per-category
 * mailboxes have no business being served to every visitor of the marketing
 * site, and nothing public renders them. Server code that needs it reads it
 * through `loadEmailIdentity()` instead.
 */
export async function getPublicSiteConfig() {
  const config = await getSiteConfig();

  return {
    announcement: config.announcement,
    apps: config.apps,
    // Page copy for the prose surfaces, read by the website and the phone alike
    // — see `contentSchema` for why it is configuration rather than component
    // constants.
    content: config.content,
    facilities: config.facilities.filter((facility) => facility.enabled),
    // Counted, not configured — see `getPublicPlatformStats`. A failed count
    // drops the live row rather than the whole config.
    platformStats: await getPublicPlatformStats().catch(() => []),
    features: config.features,
    hero: config.hero,
    identity: config.identity,
    legal: config.legal,
    // The lifetime deal as configured. Seats sold are counted on their own
    // endpoint (`/public/lifetime`) so this projection — read on every page —
    // never grows a query.
    lifetime: config.lifetime,
    locations: config.locations.filter((location) => location.enabled),
    // The whole Plans & Pricing catalogue, priced as it is actually sold right
    // now: in standard mode this is the stored section untouched, and during a
    // running event each plan carries its offer price with the list price kept
    // beside it. Public by definition — it is the page — and read by the
    // website's pricing, service and badge routes, and by the phone.
    plans: sellingCatalog(config.plans, currentBsPeriod()),
    // The student resident row's switch, label and link — read by both homes.
    questionCall: config.questionCall,
    // Titles, descriptions, verification tags and the search landing pages.
    // Nothing private: every field ends up in a page head or on a public page.
    seo: config.seo,
    social: config.social,
    stats: config.stats,
    trustPoints: config.trustPoints,
  };
}

export type PublicSiteConfig = Awaited<ReturnType<typeof getPublicSiteConfig>>;
