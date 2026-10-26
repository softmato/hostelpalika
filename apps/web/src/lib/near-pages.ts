import "server-only";

import { cache } from "react";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

import {
  mapPublicHostelToSummary,
  type PublicHostel,
} from "@/app/_components/public-hostel-data";
import type { HostelSummary } from "@/app/_components/public-hostel-types";
import { hostelTypeLabel, locationSlug } from "@/lib/hostel-locations";
import { breadcrumbJsonLd, faqJsonLd, formatNpr, itemListJsonLd } from "@/lib/json-ld";
import { PAID_PLACEMENT_NOTE } from "@/lib/listing-tier";
import { formatDistance, NEAR_RADIUS_METERS, type NearPlace } from "@/lib/near-places";
import {
  listPublicHostelsNear,
  listPublicNearbyPlaces,
} from "@/modules/hostels/hostel.service";

/**
 * `/hostels/near` and `/hostels/near/[place]` — the pages for "hostels near
 * Pulchowk Campus", "hostel near Tri-Chandra College".
 *
 * Like the city pages, nothing is written by hand: the campus, the hostels, the
 * distances, the rent range and every answer come from the published listings
 * and the nearby places each hostel's own pin found (`lib/near-places.ts`). A
 * campus with no published hostel nearby has no page at all — a 404, never a
 * thin page — so the set of pages grows only as real hostels arrive.
 *
 * A database failure throws: a 5xx asks a crawler to come back, an empty 200
 * would teach it the campus has no hostels.
 */

export const loadNearPlaces = cache(async (): Promise<NearPlace[]> => listPublicNearbyPlaces());

export type NearPageHostel = HostelSummary & { distance: string; distanceMeters: number };

export type NearPage = {
  cityPath: string | null;
  crumbs: Array<{ name: string; path: string }>;
  description: string;
  faq: Array<{ answer: string; question: string }>;
  heading: string;
  hostels: NearPageHostel[];
  intro: string;
  /** Shown only when a badged hostel is actually ordered first. */
  placementNote: string | null;
  otherPlaces: Array<{ count: number; href: string; label: string }>;
  path: string;
  place: NearPlace;
  title: string;
};

function joinList(items: string[]) {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

function counted(count: number, singular: string) {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}

export const loadNearPage = cache(async (slug: string): Promise<NearPage | null> => {
  const result = await listPublicHostelsNear(slug);

  if (!result || result.hostels.length === 0) {
    return null;
  }

  const { place } = result;
  const rows = result.hostels as Array<PublicHostel & { distanceMeters: number }>;
  const hostels: NearPageHostel[] = rows.map((hostel) => ({
    ...mapPublicHostelToSummary(hostel),
    distance: formatDistance(hostel.distanceMeters),
    distanceMeters: hostel.distanceMeters,
  }));

  const where = place.city ? `${place.name}, ${place.city}` : place.name;
  const count = hostels.length;
  const nearest = [...hostels].sort((a, b) => a.distanceMeters - b.distanceMeters)[0];
  const rents = rows.flatMap((hostel) =>
    [hostel.pricing?.monthlyRentMin, hostel.pricing?.monthlyRentMax].filter(
      (value): value is number => typeof value === "number" && value > 0,
    ),
  );
  const min = rents.length ? Math.min(...rents) : 0;
  const max = rents.length ? Math.max(...rents) : 0;
  const path = `/hostels/near/${place.slug}`;
  const radius = formatDistance(NEAR_RADIUS_METERS);

  const title = `Hostels Near ${place.name}${place.city ? `, ${place.city}` : ""} — Rent & Distance`;
  const description = `${counted(count, "verified hostel")} within ${radius} of ${where}${
    min ? `, rent from ${formatNpr(min)} a month` : ""
  }. The nearest is ${nearest.name}, about ${nearest.distance} away. Photos, rooms and reviews on ${PLATFORM_NAME}.`;

  const intro = `${count === 1 ? "One verified hostel is" : `${count} verified hostels are`} listed within ${radius} of ${where} on ${PLATFORM_NAME}${
    min && max > min
      ? `, with monthly rent from ${formatNpr(min)} to ${formatNpr(max)}`
      : min
        ? `, with monthly rent from ${formatNpr(min)}`
        : ""
  }. The nearest is ${nearest.name}, about ${nearest.distance} away in a straight line. Every distance below is measured from the hostel's own map pin, so walk the route before you decide.`;

  const types = new Map<string, number>();
  for (const hostel of rows) {
    const label = hostelTypeLabel(hostel.hostelType).toLowerCase();
    types.set(label, (types.get(label) ?? 0) + 1);
  }

  const faq: NearPage["faq"] = [
    {
      answer: `${joinList(
        hostels
          .slice()
          .sort((a, b) => a.distanceMeters - b.distanceMeters)
          .slice(0, 8)
          .map((hostel) => `${hostel.name} (about ${hostel.distance})`),
      )}${count > 8 ? `, and ${count - 8} more on this page` : ""}.`,
      question: `Which hostels are near ${place.name}?`,
    },
  ];

  if (min) {
    faq.push({
      answer: `Monthly rent at the hostels listed near ${place.name} starts from ${formatNpr(min)}${
        max > min ? ` and goes up to ${formatNpr(max)}` : ""
      }, depending on the hostel and the room type. Each hostel's page shows the rent for every room type.`,
      question: `How much does a hostel near ${place.name} cost?`,
    });
  }

  faq.push(
    {
      answer: `Near ${place.name}, ${PLATFORM_NAME} lists ${joinList(
        [...types.entries()].map(([label, value]) => counted(value, label)),
      )}.`,
      question: `Are there boys and girls hostels near ${place.name}?`,
    },
    {
      answer: `In a straight line from each hostel's map pin to ${place.name}, using the places found around that pin within ${radius}. Road distance is longer, and a pin placed from the address rather than by the owner can be a little off — check the route on the hostel's page.`,
      question: "How is the distance measured?",
    },
  );

  const cityPath = place.city ? `/hostels/in/${locationSlug(place.city)}` : null;
  const crumbs = [
    { name: "Home", path: "/" },
    { name: "Hostels", path: "/hostels" },
    { name: "Near a college", path: "/hostels/near" },
    { name: `Near ${place.name}`, path },
  ];

  const otherPlaces = (await loadNearPlaces())
    .filter((entry) => entry.slug !== place.slug && (!place.city || entry.city === place.city))
    .slice(0, 12)
    .map((entry) => ({
      count: entry.distances.size,
      href: `/hostels/near/${entry.slug}`,
      label: entry.name,
    }));

  return {
    cityPath,
    crumbs,
    description,
    faq,
    heading: `Hostels near ${place.name}`,
    hostels,
    intro,
    otherPlaces,
    path,
    place,
    placementNote: hostels.some((hostel) => hostel.listingTier) ? PAID_PLACEMENT_NOTE : null,
    title,
  };
});

export function nearPageJsonLd(page: NearPage) {
  return [
    breadcrumbJsonLd(page.crumbs),
    itemListJsonLd(
      page.heading,
      page.hostels.map((hostel) => ({ name: hostel.name, path: `/hostels/${hostel.slug}` })),
    ),
    faqJsonLd(page.faq),
  ];
}
