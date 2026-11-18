import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PublicNearPlacePage } from "@/app/_components/public-location-page";
import { JsonLd } from "@/components/json-ld";
import { loadNearPage, nearPageJsonLd } from "@/lib/near-pages";
import { NOINDEX, pageMetadata } from "@/lib/seo";

/**
 * No paths at build: each one renders on its first visit, then is served from
 * the ISR cache until its window or `HOSTELS_TAG` clears it. Without this the
 * route rendered on every request — the busiest CPU line on the project.
 */
export function generateStaticParams() {
  return [];
}

type PageParams = {
  params: Promise<{ place: string }>;
};

/** "Hostels near Pulchowk Campus" — see `lib/near-pages.ts` for how the page is written. */
export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { place } = await params;
  const page = await loadNearPage(place);

  if (!page) {
    return { robots: NOINDEX, title: "Place not found" };
  }

  return pageMetadata({
    description: page.description,
    eyebrow: "Hostels near a college",
    path: page.path,
    title: page.title,
  });
}

export default async function HostelsNearPlacePage({ params }: PageParams) {
  const { place } = await params;
  const page = await loadNearPage(place);

  if (!page) {
    notFound();
  }

  return (
    <>
      <JsonLd data={nearPageJsonLd(page)} />
      <PublicNearPlacePage page={page} />
    </>
  );
}
