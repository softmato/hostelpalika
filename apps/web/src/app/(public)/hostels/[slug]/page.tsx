import type { Metadata } from "next";
import { notFound } from "next/navigation";

import type { PublicHostel } from "@/app/_components/public-hostel-data";
import { PublicHostelDetailPage } from "@/app/_components/public-hostel-detail-page";
import { JsonLd } from "@/components/json-ld";
import { hostelTypeLabel, locationSlug } from "@/lib/hostel-locations";
import { breadcrumbJsonLd, formatNpr, hostelJsonLd } from "@/lib/json-ld";
import { NOINDEX, pageMetadata, snippet } from "@/lib/seo";

import { loadHostel, loadSearchPhotos } from "./load-hostel";

type PageParams = {
  params: Promise<{ slug: string }>;
};

/*
 * One hostel, read on the server.
 *
 * This page used to render an empty shell and fetch the hostel in the browser,
 * so a crawler — or a WhatsApp link preview, or anyone on a slow phone — got a
 * skeleton and nothing else. Now the hostel is in the first response and the
 * client component starts from it instead of fetching it again. Whether it
 * exists is settled by `layout.tsx` before anything streams; see there for why.
 */

function placeOf(hostel: PublicHostel) {
  return [hostel.location.area, hostel.location.city]
    .filter((part, index, parts) => part && parts.indexOf(part) === index)
    .join(", ");
}

function ratingOf(hostel: PublicHostel) {
  const summary = (hostel as PublicHostel & {
    ratingSummary?: { averageRating?: number; total?: number };
  }).ratingSummary;

  return summary?.total
    ? { averageRating: summary.averageRating ?? 0, total: summary.total }
    : null;
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { slug } = await params;
  const hostel = await loadHostel(slug);

  if (!hostel) {
    return { robots: NOINDEX, title: "Hostel not found" };
  }

  if (hostel.isDemoData) {
    return { robots: NOINDEX, title: hostel.name };
  }

  const type = hostelTypeLabel(hostel.hostelType);
  const place = placeOf(hostel);
  const rating = ratingOf(hostel);
  const rent = hostel.pricing?.monthlyRentMin
    ? ` Rent from ${formatNpr(hostel.pricing.monthlyRentMin)} a month.`
    : "";
  const rated = rating
    ? ` Rated ${rating.averageRating.toFixed(1)} from ${rating.total} review${rating.total === 1 ? "" : "s"}.`
    : "";
  const lead = `${hostel.name} is a verified ${type.toLowerCase()}${place ? ` in ${place}` : ""}.${rent}${rated}`;
  const title = /hostel/i.test(hostel.name)
    ? `${hostel.name}${place ? `, ${place}` : ""}`
    : `${hostel.name} — ${type}${place ? ` in ${place}` : ""}`;
  const [cover] = await loadSearchPhotos(slug);

  return pageMetadata({
    description: snippet(`${lead} ${hostel.description ?? ""}`, 180),
    image: cover ? { alt: hostel.name, url: cover } : null,
    path: `/hostels/${hostel.slug}`,
    title,
  });
}

export default async function HostelDetailPage({ params }: PageParams) {
  const { slug } = await params;
  const hostel = await loadHostel(slug);

  if (!hostel) {
    notFound();
  }

  const city = hostel.location.city;
  const path = `/hostels/${hostel.slug}`;
  const photos = await loadSearchPhotos(slug);

  // No structured data (and so no review stars) for a sample listing.
  if (hostel.isDemoData) {
    return <PublicHostelDetailPage key={hostel.id} initialHostel={hostel} />;
  }

  return (
    <>
      <JsonLd
        data={[
          hostelJsonLd({
            coordinates: hostel.coordinates,
            description: hostel.description,
            facilities: hostel.facilities,
            location: hostel.location,
            name: hostel.name,
            phone: hostel.contact?.phone,
            photos,
            pricing: hostel.pricing,
            rating: ratingOf(hostel),
            rooms: hostel.roomConfigurations,
            slug: hostel.slug,
          }),
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Hostels", path: "/hostels" },
            ...(city ? [{ name: `Hostels in ${city}`, path: `/hostels/in/${locationSlug(city)}` }] : []),
            { name: hostel.name, path },
          ]),
        ]}
      />
      <PublicHostelDetailPage key={hostel.id} initialHostel={hostel} />
    </>
  );
}
