import type { Metadata } from "next";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

import { PublicCitiesPage } from "@/app/_components/public-location-page";
import { JsonLd } from "@/components/json-ld";
import { breadcrumbJsonLd, itemListJsonLd } from "@/lib/json-ld";
import { loadCityIndex } from "@/lib/location-pages";
import { pageMetadata } from "@/lib/seo";

export async function generateMetadata(): Promise<Metadata> {
  const cities = await loadCityIndex();
  const named = cities.slice(0, 4).map((city) => city.name);

  return pageMetadata({
    description: `Find verified hostels in ${named.join(", ")} and every city ${PLATFORM_NAME} is open in — boys, girls and co-living hostels with photos, rent and reviews.`,
    eyebrow: "Hostels in Nepal",
    path: "/hostels/in",
    title: named.length
      ? `Hostels in Nepal by City — ${named.slice(0, 3).join(", ")} & More`
      : "Hostels in Nepal by City",
  });
}

export default async function HostelCitiesPage() {
  const cities = await loadCityIndex();

  return (
    <>
      <JsonLd
        data={[
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Hostels", path: "/hostels" },
            { name: "By city", path: "/hostels/in" },
          ]),
          itemListJsonLd(
            "Hostels in Nepal by city",
            cities.map((city) => ({ name: `Hostels in ${city.name}`, path: `/hostels/in/${city.slug}` })),
          ),
        ]}
      />
      <PublicCitiesPage cities={cities} />
    </>
  );
}
