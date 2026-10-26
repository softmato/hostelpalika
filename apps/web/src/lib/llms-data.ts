import "server-only";

import { listingTiers } from "@/app/_components/plans-catalog";
import {
  mapPublicHostelToSummary,
  type PublicHostel,
} from "@/app/_components/public-hostel-data";
import { loadCityIndex } from "@/lib/location-pages";
import type { LlmsData } from "@/lib/llms-txt";
import { loadNearPlaces } from "@/lib/near-pages";
import { loadSeo, resolveModulePages, resolveSoftwarePage, resolveComparison } from "@/lib/seo-config";
import { siteUrl } from "@/lib/site";
import { listPublicHostels } from "@/modules/hostels/hostel.service";

/**
 * Everything `/llms.txt` and `/llms-full.txt` print, read from the same loaders
 * the pages use. A failed listing read throws — the route answers 5xx and is
 * retried — rather than publishing "no hostels" to every tool that reads it.
 */
export async function loadLlmsData(): Promise<LlmsData> {
  const [{ config, fill, seo }, cities, near, { hostels }] = await Promise.all([
    loadSeo(),
    loadCityIndex(),
    loadNearPlaces(),
    listPublicHostels({}),
  ]);
  const tiers = new Map(listingTiers(config.plans).map(({ plan, tier }) => [plan.id, tier.label]));
  const software = resolveSoftwarePage(seo, fill);

  return {
    base: siteUrl(),
    cities,
    comparisons: seo.comparisons.flatMap((comparison) => {
      const resolved = resolveComparison(seo, comparison.slug, fill);
      return resolved ? [{ name: resolved.name, slug: resolved.slug, title: resolved.title }] : [];
    }),
    features: resolveModulePages(seo, config.plans, fill).map((page) => ({
      description: page.description,
      headline: page.headline,
      slug: page.slug,
    })),
    hostels: (hostels as PublicHostel[])
      .filter((hostel) => !hostel.isDemoData)
      .map((hostel) => {
        const summary = mapPublicHostelToSummary(hostel);
        return {
          area: summary.area,
          city: summary.city,
          listingTier: hostel.listingTier?.label ?? null,
          name: summary.name,
          price: summary.price,
          rating: summary.rating,
          reviews: summary.reviews,
          slug: summary.slug,
          type: hostel.hostelType,
        };
      }),
    modules: config.plans.modules.map((entry) => ({
      description: entry.description,
      name: entry.name,
    })),
    near: near.map((place) => ({
      city: place.city,
      count: place.distances.size,
      name: place.name,
      slug: place.slug,
    })),
    plans: config.plans.plans.map((plan) => ({
      badge: tiers.get(plan.id) ?? null,
      monthly: plan.monthly,
      name: plan.name,
    })),
    software: { faq: software.faq, sections: software.sections },
  };
}
