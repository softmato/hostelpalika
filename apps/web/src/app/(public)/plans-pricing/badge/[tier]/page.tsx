import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { getListingTier, listingTiers } from "@/app/_components/plans-catalog";
import { PublicListingBadgePage } from "@/app/_components/public-listing-badge-page";
import { NOINDEX, pageMetadata } from "@/lib/seo";
import { loadSiteConfig } from "@/lib/site-config-server";
import { DEFAULT_PLANS } from "@/lib/platform-config/plans.defaults";

type PageParams = {
  params: Promise<{ tier: string }>;
};

/**
 * A badge exists because a plan grants it, and plans are owner-editable — so the
 * same contract as the service pages next door: the shipped badges prerender,
 * a badge added later resolves on request, and an unknown slug is a 404 rather
 * than a rendered empty page.
 */
export const dynamicParams = true;

export function generateStaticParams() {
  return listingTiers(DEFAULT_PLANS).map(({ tier }) => ({ tier: tier.slug }));
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { tier: slug } = await params;
  const { plans: catalog } = await loadSiteConfig();
  const entry = getListingTier(catalog, slug);

  if (!entry) {
    return { robots: NOINDEX, title: "Badge not found" };
  }

  return pageMetadata({
    description: `${entry.tier.note} Comes with the ${entry.plan.name} plan.`,
    eyebrow: "Listing badge",
    path: `/plans-pricing/badge/${entry.tier.slug}`,
    title: `${entry.tier.label} badge`,
  });
}

export default async function ListingBadgePage({ params }: PageParams) {
  const { tier: slug } = await params;
  const { plans: catalog } = await loadSiteConfig();
  const entry = getListingTier(catalog, slug);

  if (!entry) {
    notFound();
  }

  return (
    <PublicListingBadgePage catalog={catalog} plan={entry.plan} tier={entry.tier} />
  );
}
