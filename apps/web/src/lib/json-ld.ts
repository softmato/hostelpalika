import {
  PLATFORM_NAME,
  PLATFORM_PLAY_STORE_URL,
  PLATFORM_VENDOR,
  PLATFORM_VENDOR_URL,
} from "@hostel/shared/brand/brand";

import { siteUrl } from "@/lib/site";

/**
 * schema.org records for the public site, one builder per kind of page.
 *
 * The rule for every builder: state only what the page itself shows. A rating
 * appears only when real reviews exist, a price only when the hostel set one,
 * and nothing is inferred to make a result look richer — structured data that
 * disagrees with the page is how a site loses rich results altogether.
 *
 * Builders return plain objects; `serializeJsonLd` is the only way they reach
 * HTML, because hostel names and descriptions are typed by owners and a
 * `</script>` inside one must not close the tag.
 */

type JsonLd = Record<string, unknown>;

const CONTEXT = "https://schema.org";

export function absoluteUrl(path: string) {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }

  return `${siteUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}

export function organizationId() {
  return `${siteUrl()}/#organization`;
}

function websiteId() {
  return `${siteUrl()}/#website`;
}

const LINE_SEPARATOR = new RegExp(String.fromCharCode(0x2028), "g");
const PARAGRAPH_SEPARATOR = new RegExp(String.fromCharCode(0x2029), "g");

/** Safe inside `<script type="application/ld+json">`, whatever an owner typed. */
export function serializeJsonLd(data: JsonLd | JsonLd[]) {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(LINE_SEPARATOR, "\\u2028")
    .replace(PARAGRAPH_SEPARATOR, "\\u2029");
}

/**
 * Softmato, the company HostelPalika is a product of. Declared on the product's
 * own records so search engines connect the two, and linked from the footer so
 * a person can see it too.
 */
export function vendorJsonLd(legalName?: string): JsonLd {
  return {
    "@type": "Organization",
    legalName: legalName || undefined,
    logo: absoluteUrl("/brand/softmato.png"),
    name: PLATFORM_VENDOR,
    url: PLATFORM_VENDOR_URL,
  };
}

export function organizationJsonLd(input: {
  address: string;
  alternateNames: string[];
  email: string;
  phone: string;
  sameAs: string[];
  vendorLegalName?: string;
}): JsonLd {
  const contact = input.email || input.phone;

  return {
    "@context": CONTEXT,
    "@id": organizationId(),
    "@type": "Organization",
    address: input.address
      ? { "@type": "PostalAddress", addressCountry: "NP", addressLocality: input.address }
      : undefined,
    alternateName: input.alternateNames.length ? input.alternateNames : undefined,
    areaServed: { "@type": "Country", name: "Nepal" },
    contactPoint: contact
      ? [
          {
            "@type": "ContactPoint",
            areaServed: "NP",
            contactType: "customer support",
            email: input.email || undefined,
            telephone: input.phone || undefined,
          },
        ]
      : undefined,
    email: input.email || undefined,
    logo: absoluteUrl("/icon.png"),
    name: PLATFORM_NAME,
    parentOrganization: vendorJsonLd(input.vendorLegalName),
    sameAs: input.sameAs.length ? input.sameAs : undefined,
    url: siteUrl(),
  };
}

/** The sitelinks search box searches the hostel listing, the site's real search. */
export function websiteJsonLd(alternateNames: string[] = []): JsonLd {
  return {
    "@context": CONTEXT,
    "@id": websiteId(),
    "@type": "WebSite",
    alternateName: alternateNames.length ? alternateNames : undefined,
    inLanguage: "en-NP",
    name: PLATFORM_NAME,
    potentialAction: {
      "@type": "SearchAction",
      "query-input": "required name=search_term_string",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${siteUrl()}/hostels?search={search_term_string}`,
      },
    },
    publisher: { "@id": organizationId() },
    url: siteUrl(),
  };
}

/**
 * The product itself, on the web and on Google Play. Add iOS the day the App
 * Store listing is live, not before.
 */
export function softwareApplicationJsonLd(input: {
  description: string;
  features: string[];
  monthlyPrices: number[];
}): JsonLd {
  const url = absoluteUrl("/hostel-management-software");

  const prices = input.monthlyPrices.filter((price) => price > 0);

  return {
    "@context": CONTEXT,
    "@id": `${url}#software`,
    "@type": "SoftwareApplication",
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "Hostel management software",
    description: input.description,
    featureList: input.features.length ? input.features : undefined,
    name: PLATFORM_NAME,
    offers: prices.length
      ? {
          "@type": "AggregateOffer",
          highPrice: Math.max(...prices),
          lowPrice: Math.min(...prices),
          offerCount: prices.length,
          priceCurrency: "NPR",
        }
      : undefined,
    creator: vendorJsonLd(),
    operatingSystem: "Web, Android",
    installUrl: PLATFORM_PLAY_STORE_URL,
    downloadUrl: PLATFORM_PLAY_STORE_URL,
    publisher: { "@id": organizationId() },
    url,
  };
}

export function breadcrumbJsonLd(items: Array<{ name: string; path: string }>): JsonLd {
  return {
    "@context": CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      item: absoluteUrl(item.path),
      name: item.name,
      position: index + 1,
    })),
  };
}

/** Only for a FAQ that is visible on the same page. */
export function faqJsonLd(
  entries: Array<{ answer: string; question: string }>,
): JsonLd | null {
  const faq = entries.filter((entry) => entry.question && entry.answer);

  if (faq.length === 0) {
    return null;
  }

  return {
    "@context": CONTEXT,
    "@type": "FAQPage",
    mainEntity: faq.map((entry) => ({
      "@type": "Question",
      acceptedAnswer: { "@type": "Answer", text: entry.answer },
      name: entry.question,
    })),
  };
}

export function itemListJsonLd(
  name: string,
  entries: Array<{ name: string; path: string }>,
): JsonLd {
  return {
    "@context": CONTEXT,
    "@type": "ItemList",
    itemListElement: entries.map((entry, index) => ({
      "@type": "ListItem",
      name: entry.name,
      position: index + 1,
      url: absoluteUrl(entry.path),
    })),
    name,
    numberOfItems: entries.length,
  };
}

export function formatNpr(value: number) {
  return `NPR ${Math.round(value).toLocaleString("en-IN")}`;
}

export type HostelJsonLdInput = {
  coordinates?: { lat: number; lng: number } | null;
  description?: string;
  facilities: string[];
  location: { address?: string; area?: string; city?: string; province?: string };
  name: string;
  phone?: string;
  photos: string[];
  pricing?: { monthlyRentMax?: number; monthlyRentMin?: number };
  rating?: { averageRating: number; total: number } | null;
  rooms?: Array<{ monthlyRent: number; roomType: string }>;
  slug: string;
};

export function hostelJsonLd(hostel: HostelJsonLdInput): JsonLd {
  const url = absoluteUrl(`/hostels/${hostel.slug}`);
  const min = hostel.pricing?.monthlyRentMin ?? 0;
  const max = hostel.pricing?.monthlyRentMax ?? 0;
  const streetAddress = [hostel.location.address, hostel.location.area]
    .filter(Boolean)
    .join(", ");
  const rooms = (hostel.rooms ?? []).filter((room) => room.monthlyRent > 0);

  let priceRange: string | undefined;
  if (min > 0 && max > min) {
    priceRange = `${formatNpr(min)}–${formatNpr(max)} per month`;
  } else if (min > 0 || max > 0) {
    priceRange = `${formatNpr(min || max)} per month`;
  }

  return {
    "@context": CONTEXT,
    "@id": `${url}#hostel`,
    "@type": "Hostel",
    // People search "Education Light hostel" for a hostel named "Education Light".
    alternateName: /hostel/i.test(hostel.name) ? undefined : `${hostel.name} Hostel`,
    address: {
      "@type": "PostalAddress",
      addressCountry: "NP",
      addressLocality: hostel.location.city || undefined,
      addressRegion: hostel.location.province || undefined,
      streetAddress: streetAddress || undefined,
    },
    aggregateRating:
      hostel.rating && hostel.rating.total > 0
        ? {
            "@type": "AggregateRating",
            bestRating: 5,
            ratingValue: Number(hostel.rating.averageRating.toFixed(1)),
            reviewCount: hostel.rating.total,
            worstRating: 1,
          }
        : undefined,
    amenityFeature: hostel.facilities.length
      ? hostel.facilities.map((facility) => ({
          "@type": "LocationFeatureSpecification",
          name: facility,
          value: true,
        }))
      : undefined,
    description: hostel.description || undefined,
    geo: hostel.coordinates
      ? {
          "@type": "GeoCoordinates",
          latitude: hostel.coordinates.lat,
          longitude: hostel.coordinates.lng,
        }
      : undefined,
    image: hostel.photos.length ? hostel.photos : undefined,
    makesOffer: rooms.length
      ? rooms.map((room) => ({
          "@type": "Offer",
          name: `${room.roomType} room`,
          priceSpecification: {
            "@type": "UnitPriceSpecification",
            price: room.monthlyRent,
            priceCurrency: "NPR",
            unitText: "month",
          },
        }))
      : undefined,
    name: hostel.name,
    priceRange,
    telephone: hostel.phone || undefined,
    url,
  };
}
