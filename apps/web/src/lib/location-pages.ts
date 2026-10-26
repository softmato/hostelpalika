import "server-only";

import { cache } from "react";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

import {
  mapPublicHostelToSummary,
  type PublicHostel,
} from "@/app/_components/public-hostel-data";
import type { HostelSummary } from "@/app/_components/public-hostel-types";
import {
  buildCityIndex,
  HOSTEL_TYPE_PAGES,
  hostelTypePage,
  locationSlug,
  type CityIndexEntry,
} from "@/lib/hostel-locations";
import { breadcrumbJsonLd, faqJsonLd, formatNpr, itemListJsonLd } from "@/lib/json-ld";
import { PAID_PLACEMENT_NOTE } from "@/lib/listing-tier";
import { haversineMeters } from "@/lib/maps/nearby";
import { loadNearPlaces } from "@/lib/near-pages";
import { loadSiteConfig } from "@/lib/site-config-server";
import {
  listPublicHostelLocations,
  listPublicHostels,
} from "@/modules/hostels/hostel.service";

/**
 * `/hostels/in/[city]` and `/hostels/in/[city]/[type-or-area]` — the pages that
 * answer "hostels in Kathmandu", "girls hostel in Lalitpur", "hostel in
 * Baneshwor".
 *
 * Nothing on them is written by hand. The count, the rent range, the areas, the
 * questions and their answers are all computed from the published listings, so
 * a page can never promise hostels that are not there — and a page with none
 * yet is `noindex` rather than a thin page Google would hold against the site.
 *
 * A database failure throws instead of rendering an empty page: a 5xx asks a
 * crawler to come back, an empty 200 would teach it the city has no hostels.
 */

export const loadCityIndex = cache(async (): Promise<CityIndexEntry[]> => {
  const { locations } = await loadSiteConfig();

  return buildCityIndex(await listPublicHostelLocations(), locations);
});

type Link = { active: boolean; count: number; href: string; label: string };

export type LocationPage = {
  areaLinks: Link[];
  city: CityIndexEntry;
  crumbs: Array<{ name: string; path: string }>;
  description: string;
  faq: Array<{ answer: string; question: string }>;
  heading: string;
  hostels: HostelSummary[];
  intro: string;
  /** Campuses in this city with a listed hostel nearby — `/hostels/near/...`. */
  nearLinks: Array<{ count: number; href: string; label: string }>;
  /**
   * Area pages only: hostels in the same city within {@link NEARBY_AREA_METERS}
   * of one in the area, so "hostels in Baneshwor & nearby" is literally true.
   */
  nearby: HostelSummary[];
  noindex: boolean;
  /** How the list is ordered — always shown, since the titles say "best". */
  orderNote: string;
  otherCities: Array<{ count: number; href: string; label: string }>;
  path: string;
  placeName: string;
  title: string;
  typeLinks: Link[];
};

/** "& nearby" on an area page: another hostel in the city within this of one in the area. */
export const NEARBY_AREA_METERS = 2000;

function joinList(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function titleCase(value: string) {
  return value.replace(/(^|\s)([a-z])/g, (_, space: string, letter: string) =>
    `${space}${letter.toUpperCase()}`,
  );
}

function counted(count: number, singular: string) {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export const loadLocationPage = cache(
  async (citySlug: string, filterSlug?: string): Promise<LocationPage | null> => {
    const index = await loadCityIndex();
    const city = index.find((entry) => entry.slug === citySlug);

    if (!city) return null;

    const type = filterSlug ? hostelTypePage(filterSlug) : null;
    const area =
      filterSlug && !type ? (city.areas.find((entry) => entry.slug === filterSlug) ?? null) : null;

    if (filterSlug && !type && !area) return null;

    // An area page also reads its city, for the hostels close enough to the
    // area's own to be "nearby".
    const [{ hostels }, cityRead] = await Promise.all([
      listPublicHostels({ area: area?.name, city: city.name, type: type?.type }),
      area ? listPublicHostels({ city: city.name, type: type?.type }) : null,
    ]);

    // Sample listings stay off these indexed pages: their counts and answers are what Google reads.
    const real = (list: unknown) =>
      (JSON.parse(JSON.stringify(list)) as PublicHostel[]).filter((hostel) => !hostel.isDemoData);
    // The area query matches by substring ("Baneshwor" finds "New Baneshwor");
    // the page lists exactly the area it is named after.
    const rows = real(hostels).filter(
      (hostel) => !area || locationSlug(hostel.location.area ?? "") === area.slug,
    );
    const cityRows = cityRead ? real(cityRead.hostels) : [];
    const summaries = rows.map(mapPublicHostelToSummary);
    const pinned = rows.flatMap((hostel) => (hostel.coordinates ? [hostel.coordinates] : []));
    const nearby = area
      ? cityRows
          .filter(
            (hostel) =>
              locationSlug(hostel.location.area ?? "") !== area.slug &&
              hostel.coordinates &&
              pinned.some(
                (point) => haversineMeters(point, hostel.coordinates!) <= NEARBY_AREA_METERS,
              ),
          )
          .map(mapPublicHostelToSummary)
      : [];

    const rents = rows.flatMap((hostel) =>
      [hostel.pricing?.monthlyRentMin, hostel.pricing?.monthlyRentMax].filter(
        (value): value is number => typeof value === "number" && value > 0,
      ),
    );
    const min = rents.length ? Math.min(...rents) : 0;
    const max = rents.length ? Math.max(...rents) : 0;

    const kind = type ? type.label.toLowerCase() : "hostels";
    const singular = kind.replace(/s$/, "");
    const placeName = area ? `${area.name}, ${city.name}` : city.name;
    const heading = `${titleCase(kind)} in ${placeName}`;
    const count = summaries.length;
    const path = `/hostels/in/${city.slug}${filterSlug ? `/${filterSlug}` : ""}`;

    /*
     * "Best hostels in Kathmandu" is how people search, so the title answers it
     * — and the page says exactly how its list is ordered (`orderNote`), so the
     * word is a promise to compare, not a ranking nobody made.
     */
    const verified = count ? ` (${count} Verified)` : "";
    let title = count ? `Best ${heading}${verified} — Rent & Reviews` : `${heading}, Nepal`;
    if (!type && !area && count) {
      title = `Best Hostels in ${city.name}${verified} — Boys, Girls & Co-living`;
    }
    if (area && count && nearby.length) {
      title = `Best ${titleCase(kind)} in ${area.name} & Nearby, ${city.name} — Rent & Reviews`;
    }

    const rentFrom = min ? ` rent from ${formatNpr(min)} a month,` : "";
    const alsoNearby = nearby.length ? ` plus ${nearby.length} nearby` : "";
    const description = count
      ? `${counted(count, `verified ${singular}`)} in ${placeName}${alsoNearby}, Nepal with photos,${rentFrom} facilities and reviews. Compare and contact hostels on ${PLATFORM_NAME}.`
      : `Verified ${kind} in ${placeName}, Nepal, on ${PLATFORM_NAME} — photos, rent, facilities and reviews from residents.`;

    let rentPhrase = "";
    if (min && max > min) rentPhrase = `, with monthly rent from ${formatNpr(min)} to ${formatNpr(max)}`;
    else if (min) rentPhrase = `, with monthly rent from ${formatNpr(min)}`;

    const intro = count
      ? `${count === 1 ? `One verified ${singular} in ${placeName} is` : `${count} verified ${kind} in ${placeName} are`} listed on ${PLATFORM_NAME}${rentPhrase}. Every listing shows real photos, room types, facilities and reviews from people who lived there — compare hostels side by side, or call and send an inquiry from the hostel's own page.`
      : `No verified ${kind} in ${placeName} are listed on ${PLATFORM_NAME} yet. New hostels appear here as soon as they are verified; until then, browse every hostel in Nepal or open the hostel map.`;

    const faq: LocationPage["faq"] = [];

    if (min) {
      faq.push({
        answer: `On ${PLATFORM_NAME}, monthly rent for ${kind} in ${placeName} starts from ${formatNpr(min)}${max > min ? ` and goes up to ${formatNpr(max)}` : ""}, depending on the hostel and the room type.`,
        question: `How much does a hostel cost in ${placeName}?`,
      });
    }

    if (!type && !area && city.count > 0) {
      const parts = HOSTEL_TYPE_PAGES.filter((page) => city.types[page.type] > 0).map((page) =>
        counted(city.types[page.type], page.label.toLowerCase().replace(/s$/, "")),
      );
      faq.push({
        answer: `${PLATFORM_NAME} lists ${joinList(parts)} in ${city.name}.`,
        question: `Are there boys and girls hostels in ${city.name}?`,
      });
    }

    const areasWithHostels = city.areas.filter((entry) => entry.count > 0).slice(0, 12);
    if (!area && areasWithHostels.length) {
      faq.push({
        answer: `Hostels listed on ${PLATFORM_NAME} in ${city.name} are in ${joinList(areasWithHostels.map((entry) => entry.name))}.`,
        question: `Which areas of ${city.name} have hostels?`,
      });
    }

    const cheapest = rows
      .filter((hostel) => (hostel.pricing?.monthlyRentMin ?? 0) > 0)
      .sort((a, b) => (a.pricing?.monthlyRentMin ?? 0) - (b.pricing?.monthlyRentMin ?? 0))[0];
    if (cheapest && count > 1) {
      faq.push({
        answer: `Among the ${kind} listed on ${PLATFORM_NAME} in ${placeName}, ${cheapest.name} has the lowest starting rent, from ${formatNpr(cheapest.pricing!.monthlyRentMin!)} a month. Check which room type that price is for on its page — shared rooms cost less than single rooms.`,
        question: `What is the cheapest hostel in ${placeName}?`,
      });
    }

    const singles = rows.filter((hostel) =>
      (hostel.roomConfigurations ?? []).some((room) => room.bedsPerRoom === 1),
    );
    if (count) {
      faq.push({
        answer: singles.length
          ? `Yes. ${counted(singles.length, singular)} in ${placeName} ${singles.length === 1 ? "lists" : "list"} single rooms: ${joinList(singles.slice(0, 6).map((hostel) => hostel.name))}. Each hostel's page shows the rent and free beds for every room type.`
          : `None of the ${kind} listed in ${placeName} lists a single room right now; rooms are shared by two or more residents. Each hostel's page shows its room types and rent.`,
        question: `Can I get a single room in a hostel in ${placeName}?`,
      });
    }

    faq.push(
      {
        answer: `Yes. A hostel is listed only after the ${PLATFORM_NAME} team has checked its documents, and reviews can only be left by residents who actually stayed there.`,
        question: `Are the hostels on ${PLATFORM_NAME} verified?`,
      },
      {
        answer: `Open a hostel's page to see its rooms, rent, photos and location, then call the hostel or send an inquiry from the page to arrange a visit. Searching and contacting hostels on ${PLATFORM_NAME} is free.`,
        question: `How do I get a room in a hostel in ${placeName}?`,
      },
    );

    const badged = summaries.some((hostel) => hostel.listingTier);
    const orderNote = badged
      ? `${PAID_PLACEMENT_NOTE} After them, hostels are listed from the lowest monthly rent.`
      : "Hostels are listed from the lowest monthly rent. Ratings come only from residents who lived there, so compare rent, rooms and reviews to find the best fit for you.";

    faq.push({
      answer: `There is no single best hostel — it depends on your budget, the room you want and how far you will travel each day. ${PLATFORM_NAME} lists only verified hostels and shows each one's rent, rooms, facilities, food and residents' reviews, so you can compare up to three side by side. ${badged ? "Gold and Platinum hostels are paid placements and are marked as such." : ""}`.trim(),
      question: `Which is the best hostel in ${placeName}?`,
    });

    const cityNear = (await loadNearPlaces().catch(() => []))
      .filter((entry) => locationSlug(entry.city) === city.slug)
      .slice(0, 12)
      .map((entry) => ({
        count: entry.distances.size,
        href: `/hostels/near/${entry.slug}`,
        label: `Near ${entry.name}`,
      }));

    const cityPath = `/hostels/in/${city.slug}`;
    const crumbs = [
      { name: "Home", path: "/" },
      { name: "Hostels", path: "/hostels" },
      { name: `Hostels in ${city.name}`, path: cityPath },
      ...(filterSlug ? [{ name: heading, path }] : []),
    ];

    return {
      areaLinks: city.areas.map((entry) => ({
        active: area?.slug === entry.slug,
        count: entry.count,
        href: `${cityPath}/${entry.slug}`,
        label: entry.name,
      })),
      city,
      crumbs,
      description,
      faq,
      heading,
      hostels: summaries,
      intro,
      nearLinks: cityNear,
      nearby,
      noindex: count === 0,
      orderNote,
      otherCities: index
        .filter((entry) => entry.slug !== city.slug)
        .map((entry) => ({
          count: entry.count,
          href: `/hostels/in/${entry.slug}`,
          label: entry.name,
        })),
      path,
      placeName,
      title,
      typeLinks: [
        {
          active: !type && !area,
          count: city.count,
          href: cityPath,
          label: "All hostels",
        },
        ...HOSTEL_TYPE_PAGES.map((page) => ({
          active: type?.slug === page.slug,
          count: city.types[page.type],
          href: `${cityPath}/${page.slug}`,
          label: page.label,
        })),
      ],
    };
  },
);

export function locationJsonLd(page: LocationPage) {
  return [
    breadcrumbJsonLd(page.crumbs),
    page.hostels.length
      ? itemListJsonLd(
          page.heading,
          page.hostels.map((hostel) => ({ name: hostel.name, path: `/hostels/${hostel.slug}` })),
        )
      : null,
    faqJsonLd(page.faq),
  ];
}
