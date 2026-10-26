import type { Metadata } from "next";

import {
  mapPublicHostelToSummary,
  type PublicHostel,
} from "@/app/_components/public-hostel-data";
import { PublicHomePage } from "@/app/_components/public-home-page";
import type { HostelSummary } from "@/app/_components/public-hostel-types";
import { listingTiers } from "@/app/_components/plans-catalog";
import { SeoFaq } from "@/app/_components/public-seo-blocks";
import { JsonLd } from "@/components/json-ld";
import { homeFaq } from "@/lib/home-faq";
import { faqJsonLd } from "@/lib/json-ld";
import { loadCityIndex } from "@/lib/location-pages";
import { cheapestMonthly, loadSeo, staticPageMetadata } from "@/lib/seo-config";
import { listPublicHostels } from "@/modules/hostels/hostel.service";

export function generateMetadata(): Promise<Metadata> {
  return staticPageMetadata("home");
}

/**
 * The home page is the listing's shop window, so its cards are read on the
 * server: a crawler — and anyone on a slow connection — gets real hostels in the
 * first response rather than an empty grid that fills in later.
 *
 * A failed read must not take the marketing page down with it; the sections then
 * show the same empty state a platform with no hostels yet would show.
 */
async function loadHostels(): Promise<HostelSummary[]> {
  try {
    const { hostels } = await listPublicHostels({});
    return (hostels as PublicHostel[]).map(mapPublicHostelToSummary);
  } catch {
    return [];
  }
}

export default async function HomePage() {
  const [hostels, cities, { config }] = await Promise.all([
    loadHostels(),
    loadCityIndex().catch(() => []),
    loadSeo(),
  ]);
  const faq = homeFaq({
    badges: listingTiers(config.plans).map(({ plan, tier }) => ({
      label: tier.label,
      plan: plan.name,
    })),
    cities,
    fromPrice: cheapestMonthly(config.plans),
    hostels,
  });

  return (
    <>
      <JsonLd data={faqJsonLd(faq)} />
      <PublicHomePage
        faq={<SeoFaq entries={faq} title="Questions people ask about hostels in Nepal" />}
        hostels={hostels}
      />
    </>
  );
}
