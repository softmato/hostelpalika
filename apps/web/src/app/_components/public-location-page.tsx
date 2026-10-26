import { ArrowUpRight, MapPin } from "@/components/icons";
import Link from "next/link";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

import type { CityIndexEntry } from "@/lib/hostel-locations";
import type { LocationPage } from "@/lib/location-pages";

import { OwnerCallout, SeoChip, SeoCrumbs, SeoFaq } from "./public-seo-blocks";
import { HostelCard, PublicShell } from "./shared";
import { optimizedImage } from "@/lib/image-url";

/**
 * A recognisable public photograph makes the city directory easier to scan at
 * a glance. Keep a neutral Nepal fallback for cities added through the platform
 * configuration before a dedicated photograph has been curated for them.
 */
const CITY_VISUALS: Record<string, { alt: string; image: string; position?: string }> = {
  bhaktapur: {
    alt: "Bhaktapur Durbar Square",
    image:
      "https://commons.wikimedia.org/wiki/Special:FilePath/Bhaktapur%20Durbar%20Square%20March%202026%2001.jpg?width=1200",
  },
  biratnagar: {
    alt: "Aerial view of Biratnagar",
    image:
      "https://commons.wikimedia.org/wiki/Special:FilePath/Aerial%20View%20of%20Biratnagar-IMG%208813.jpg?width=1200",
  },
  chitwan: {
    alt: "Spotted deer beside a river in Chitwan National Park",
    image:
      "https://images.unsplash.com/photo-1763879184055-a41b4a53c2e6?auto=format&fit=crop&w=1200&q=85",
  },
  kathmandu: {
    alt: "Boudhanath Stupa in Kathmandu",
    image:
      "https://images.unsplash.com/photo-1759233469343-4f9baecc382e?auto=format&fit=crop&w=1200&q=85",
  },
  lalitpur: {
    alt: "Patan Durbar Square in Lalitpur",
    image:
      "https://commons.wikimedia.org/wiki/Special:FilePath/Patan%20Durbar%20Square%2001.jpg?width=1200",
  },
  pokhara: {
    alt: "Phewa Lake in Pokhara",
    image:
      "https://images.unsplash.com/photo-1729942500273-da9f330a51a9?auto=format&fit=crop&w=1200&q=85",
  },
};

const DEFAULT_CITY_VISUAL = {
  alt: "Nepal landscape",
  image:
    "https://images.unsplash.com/photo-1544735716-392fe2489ffa?auto=format&fit=crop&w=1200&q=85",
};

/**
 * The body of a `/hostels/in/...` page. A server component: every word, card
 * and link is in the first response, which is the whole point of these pages.
 * The copy arrives already computed by `loadLocationPage`.
 */

export function PublicLocationPage({ page }: { page: LocationPage }) {
  return (
    <PublicShell active="browse">
      <div className="mx-auto w-full max-w-[1360px] px-4 pb-20 pt-8 sm:px-6">
        <div className="sticky top-16 z-40 -mx-4 mb-8 border-b border-border bg-background/95 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
          <SeoCrumbs className="mb-0" items={page.crumbs} />
        </div>

        <header className="max-w-3xl">
          <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
            <MapPin className="size-4" />
            Hostels in Nepal
          </p>
          <h1 className="mt-2 font-heading text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            {page.heading}
          </h1>
        </header>

        <section aria-label={page.heading} className="mt-8">
          {page.hostels.length ? (
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {page.hostels.map((hostel) => (
                <HostelCard hostel={hostel} key={hostel.id} />
              ))}
            </div>
          ) : (
            <div className="rounded-2xl border border-dashed border-border bg-surface px-6 py-12 text-center">
              <p className="font-heading text-lg font-bold text-foreground">
                No verified hostels listed here yet
              </p>
              <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
                New hostels in {page.placeName} appear on this page as soon as they are
                verified.
              </p>
              <div className="mt-6 flex flex-wrap justify-center gap-3">
                <Link
                  className="inline-flex items-center rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground transition hover:bg-primary/90"
                  href="/hostels"
                >
                  Browse all hostels
                </Link>
                <Link
                  className="inline-flex items-center rounded-lg border border-border px-4 py-2 text-sm font-semibold text-foreground transition hover:border-primary/50"
                  href="/map"
                >
                  Open the hostel map
                </Link>
              </div>
            </div>
          )}
        </section>

        <SeoFaq
          entries={page.faq}
          title={`Questions about hostels in ${page.placeName}`}
        />

        <section className="mt-16 grid gap-4 lg:grid-cols-2">
          {page.otherCities.length ? (
            <div className="rounded-2xl border border-border bg-surface p-6">
              <h2 className="font-heading text-lg font-bold text-foreground">
                Hostels in other cities
              </h2>
              <div className="mt-4 flex flex-wrap gap-2">
                {page.otherCities.map((link) => (
                  <SeoChip key={link.href} {...link} />
                ))}
              </div>
            </div>
          ) : null}
          <OwnerCallout
            body={`List it on ${PLATFORM_NAME} to be found here, and run residents, rent, food and safety from one app.`}
            title={`Run a hostel in ${page.city.name}?`}
          />
        </section>
      </div>
    </PublicShell>
  );
}

/** `/hostels/in` — every city, with what is listed in each. */
export function PublicCitiesPage({ cities }: { cities: CityIndexEntry[] }) {
  return (
    <PublicShell active="browse">
      <div className="mx-auto w-full max-w-[1360px] px-4 pb-20 pt-8 sm:px-6">
        <SeoCrumbs
          items={[
            { name: "Home", path: "/" },
            { name: "Hostels", path: "/hostels" },
            { name: "By city", path: "/hostels/in" },
          ]}
        />

        <header className="max-w-3xl">
          <p className="inline-flex items-center gap-1.5 text-sm font-semibold text-primary">
            <MapPin className="size-4" />
            Hostels in Nepal
          </p>
          <h1 className="mt-2 font-heading text-3xl font-bold tracking-tight text-foreground sm:text-4xl">
            Hostels in Nepal by City
          </h1>
        </header>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {cities.map((city) => {
            const visual = CITY_VISUALS[city.slug] ?? DEFAULT_CITY_VISUAL;
            const listedAreas = city.areas
              .filter((area) => area.count > 0)
              .slice(0, 3)
              .map((area) => area.name)
              .join(", ");
            const listingLabel = city.count
              ? `${city.count} verified ${city.count === 1 ? "hostel" : "hostels"}`
              : "Ready for new listings";

            return (
              <Link
                className="group relative isolate flex min-h-60 overflow-hidden rounded-2xl bg-foreground shadow-sm transition duration-300 hover:-translate-y-0.5 hover:shadow-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2"
                href={`/hostels/in/${city.slug}`}
                key={city.slug}
              >
                <img
                  alt={visual.alt}
                  className="absolute inset-0 -z-20 size-full object-cover transition duration-500 group-hover:scale-105"
                  loading="lazy"
                  src={optimizedImage(visual.image, 640)}
                  style={{ objectPosition: visual.position ?? "center" }}
                />
                <div className="absolute inset-0 -z-10 bg-gradient-to-t from-black/90 via-black/30 to-black/5" />

                <div className="flex w-full flex-col justify-between p-5 text-white">
                  <div className="flex items-start justify-between gap-3">
                    <span className="rounded-full bg-white/90 px-3 py-1 text-xs font-bold text-foreground shadow-sm">
                      {listingLabel}
                    </span>
                    <span className="grid size-9 place-items-center rounded-full border border-white/35 bg-black/15 text-white backdrop-blur-sm transition group-hover:bg-primary group-hover:border-primary">
                      <ArrowUpRight aria-hidden="true" className="size-4" />
                      <span className="sr-only">View hostels in {city.name}</span>
                    </span>
                  </div>

                  <div>
                    <h2 className="font-heading text-2xl font-bold tracking-tight text-white">
                      {city.name}
                    </h2>
                    <p className="mt-1 truncate text-sm font-medium text-white/85">
                      {listedAreas || "Explore hostel options in this city"}
                    </p>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>

        <section className="mt-16">
          <OwnerCallout
            body={`List it on ${PLATFORM_NAME} to be found by students and parents across Nepal, and run residents, rent, food and safety from one app.`}
            title="Run a hostel?"
          />
        </section>
      </div>
    </PublicShell>
  );
}
