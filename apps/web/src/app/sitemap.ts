import type { MetadataRoute } from "next";

import { listingTiers } from "@/app/_components/plans-catalog";
import { HOSTEL_TYPE_PAGES } from "@/lib/hostel-locations";
import { loadCityIndex } from "@/lib/location-pages";
import { loadNearPlaces } from "@/lib/near-pages";
import { ROLE_PAGES } from "@/lib/role-pages";
import { resolveSearchImageUrls } from "@/lib/search-image-urls";
import { loadSeo, resolveModulePages } from "@/lib/seo-config";
import { siteUrl } from "@/lib/site";
import { listPublishedHostelSlugs } from "@/modules/hostels/hostel.service";

export const runtime = "nodejs";
// Regenerate at most hourly so newly-approved hostels appear without a redeploy.
export const revalidate = 3600;

type Entry = MetadataRoute.Sitemap[number];

/**
 * Every page that should be in search, and nothing that should not.
 *
 * `lastModified` is only set where it is true — a hostel's own `updatedAt`, a
 * city's newest hostel. Stamping every static page with "now" on each rebuild
 * teaches search engines the field means nothing, and then they ignore it for
 * the hostels too.
 *
 * Programmatic pages are listed only when they have something on them: a city,
 * a type or an area with no published hostel is `noindex`, so it stays out.
 */
const STATIC_ROUTES: Array<Pick<Entry, "changeFrequency" | "priority"> & { path: string }> = [
  { changeFrequency: "daily", path: "", priority: 1 },
  { changeFrequency: "daily", path: "/hostels", priority: 0.9 },
  { changeFrequency: "weekly", path: "/hostel-management-software", priority: 0.9 },
  { changeFrequency: "daily", path: "/hostels/in", priority: 0.8 },
  { changeFrequency: "monthly", path: "/features", priority: 0.8 },
  { changeFrequency: "monthly", path: "/plans-pricing", priority: 0.8 },
  { changeFrequency: "monthly", path: "/register-hostel", priority: 0.7 },
  { changeFrequency: "daily", path: "/map", priority: 0.6 },
  { changeFrequency: "daily", path: "/community", priority: 0.6 },
  { changeFrequency: "weekly", path: "/compare", priority: 0.5 },
  { changeFrequency: "monthly", path: "/service-providers", priority: 0.5 },
  { changeFrequency: "monthly", path: "/about", priority: 0.5 },
  { changeFrequency: "monthly", path: "/contact", priority: 0.5 },
  { changeFrequency: "monthly", path: "/resident-offer-program", priority: 0.3 },
  { changeFrequency: "yearly", path: "/privacy", priority: 0.2 },
  { changeFrequency: "yearly", path: "/terms", priority: 0.2 },
  { changeFrequency: "monthly", path: "/refund-policy", priority: 0.2 },
  { changeFrequency: "monthly", path: "/how-booking-works", priority: 0.3 },
];

async function hostelEntries(base: string): Promise<Entry[]> {
  try {
    const hostels = await listPublishedHostelSlugs();
    // Stored photo paths are relative; <image:loc> must be absolute and crawlable.
    const images = await resolveSearchImageUrls(hostels.flatMap((hostel) => hostel.images));

    return hostels.map((hostel) => ({
      changeFrequency: "daily",
      images: hostel.images
        .map((url) => images.get(url))
        .filter((url): url is string => Boolean(url)),
      lastModified: hostel.updatedAt,
      priority: 0.8,
      url: `${base}/hostels/${hostel.slug}`,
    }));
  } catch {
    // If the DB is unreachable at generation time, still serve the rest.
    return [];
  }
}

async function locationEntries(base: string): Promise<Entry[]> {
  try {
    const cities = await loadCityIndex();

    return cities
      .filter((city) => city.count > 0)
      .flatMap((city) => {
        const cityUrl = `${base}/hostels/in/${city.slug}`;
        const common = {
          changeFrequency: "daily" as const,
          lastModified: city.updatedAt ?? undefined,
        };

        return [
          { ...common, priority: 0.8, url: cityUrl },
          ...HOSTEL_TYPE_PAGES.filter((type) => city.types[type.type] > 0).map((type) => ({
            ...common,
            priority: 0.7,
            url: `${cityUrl}/${type.slug}`,
          })),
          ...city.areas
            .filter((area) => area.count > 0)
            .map((area) => ({ ...common, priority: 0.6, url: `${cityUrl}/${area.slug}` })),
        ];
      });
  } catch {
    return [];
  }
}

/**
 * `/hostels/near/<campus>` — a campus is listed only while a published hostel
 * has it nearby, which is also the only time the page exists at all.
 */
async function nearEntries(base: string): Promise<Entry[]> {
  try {
    const places = await loadNearPlaces();

    if (!places.length) return [];

    return [
      { changeFrequency: "weekly", priority: 0.6, url: `${base}/hostels/near` },
      ...places.map((place) => ({
        changeFrequency: "weekly" as const,
        priority: 0.6,
        url: `${base}/hostels/near/${place.slug}`,
      })),
    ];
  } catch {
    return [];
  }
}

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();

  const staticEntries: Entry[] = STATIC_ROUTES.map((route) => ({
    changeFrequency: route.changeFrequency,
    priority: route.priority,
    url: `${base}${route.path}`,
  }));

  /*
   * The plans catalogue and the SEO pages are owner-editable, so their lists
   * are read at generation time. `loadSeo` never throws, so an unreachable
   * database costs the sitemap these rows rather than the whole file.
   */
  const { config, fill, seo } = await loadSeo();
  const catalog = config.plans;

  const marketingEntries: Entry[] = [
    ...resolveModulePages(seo, catalog, fill).map((page) => ({
      changeFrequency: "monthly" as const,
      priority: 0.7,
      url: `${base}/features/${page.slug}`,
    })),
    ...ROLE_PAGES.map((page) => ({
      changeFrequency: "monthly" as const,
      priority: page.slug === "owners" ? 0.8 : 0.6,
      url: `${base}/for/${page.slug}`,
    })),
    ...seo.comparisons.map((comparison) => ({
      changeFrequency: "monthly" as const,
      priority: 0.6,
      url: `${base}/vs/${comparison.slug}`,
    })),
    ...catalog.services.map((service) => ({
      changeFrequency: "monthly" as const,
      priority: 0.5,
      url: `${base}/plans-pricing/${service.slug}`,
    })),
    ...listingTiers(catalog).map(({ tier }) => ({
      changeFrequency: "monthly" as const,
      priority: 0.4,
      url: `${base}/plans-pricing/badge/${tier.slug}`,
    })),
  ];

  const [hostels, locations, near] = await Promise.all([
    hostelEntries(base),
    locationEntries(base),
    nearEntries(base),
  ]);

  return [...staticEntries, ...marketingEntries, ...locations, ...near, ...hostels];
}
