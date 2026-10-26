import type { Metadata } from "next";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

import { PublicNearIndexPage } from "@/app/_components/public-location-page";
import { JsonLd } from "@/components/json-ld";
import { breadcrumbJsonLd, itemListJsonLd } from "@/lib/json-ld";
import { loadNearPlaces } from "@/lib/near-pages";
import { pageMetadata } from "@/lib/seo";

async function places() {
  return (await loadNearPlaces()).map((place) => ({
    city: place.city,
    count: place.distances.size,
    href: `/hostels/near/${place.slug}`,
    label: place.name,
  }));
}

export async function generateMetadata(): Promise<Metadata> {
  const list = await places();
  const named = list.slice(0, 3).map((place) => place.label);

  return pageMetadata({
    description: named.length
      ? `Verified hostels near ${named.join(", ")} and other colleges in Nepal, with the distance from each hostel. Compare rent, rooms and reviews on ${PLATFORM_NAME}.`
      : `Verified hostels near colleges in Nepal, with the distance from each hostel, on ${PLATFORM_NAME}.`,
    eyebrow: "Hostels near a college",
    // An index with nothing in it yet is not a page worth a search result.
    noindex: list.length === 0,
    path: "/hostels/near",
    title: "Hostels Near Colleges in Nepal",
  });
}

export default async function HostelsNearIndexPage() {
  const list = await places();

  return (
    <>
      <JsonLd
        data={[
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Hostels", path: "/hostels" },
            { name: "Near a college", path: "/hostels/near" },
          ]),
          list.length
            ? itemListJsonLd(
                "Hostels near colleges in Nepal",
                list.map((place) => ({ name: `Hostels near ${place.label}`, path: place.href })),
              )
            : null,
        ]}
      />
      <PublicNearIndexPage places={list} />
    </>
  );
}
