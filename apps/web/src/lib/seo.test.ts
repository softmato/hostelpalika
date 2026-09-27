import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  faqJsonLd,
  hostelJsonLd,
  serializeJsonLd,
  softwareApplicationJsonLd,
} from "@/lib/json-ld";
import { NOINDEX, ogImagePath, pageMetadata, snippet, verifiedOgText } from "@/lib/seo";
import { resolveSeoPage, seoFiller } from "@/lib/seo-config";
import { DEFAULT_PLANS } from "@/modules/platform-config/plans.defaults";
import { DEFAULT_SEO } from "@/modules/platform-config/seo.defaults";
import { SEO_PAGE_KEYS, seoSchema } from "@/modules/platform-config/site-config.validation";

beforeEach(() => {
  vi.stubEnv("JWT_ACCESS_SECRET", "s".repeat(40));
  vi.stubEnv("APP_URL", "https://hostelpalika.com");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("pageMetadata", () => {
  it("brands the social titles, sets the canonical and signs the card", () => {
    const metadata = pageMetadata({
      description: "Verified hostels in Kathmandu.",
      path: "/hostels/in/kathmandu",
      title: "Hostels in Kathmandu",
    });

    expect(metadata.title).toBe("Hostels in Kathmandu");
    expect(metadata.alternates?.canonical).toBe("/hostels/in/kathmandu");
    expect(metadata.openGraph?.title).toEqual({ absolute: "Hostels in Kathmandu · HostelPalika" });
    expect(metadata.openGraph?.siteName).toBe("HostelPalika");
    expect(metadata.robots).toBeUndefined();

    const image = (metadata.openGraph?.images as Array<{ url: string }>)[0];
    const params = new URL(image.url, "https://hostelpalika.com").searchParams;
    expect(verifiedOgText(params)).toEqual({ eyebrow: "", title: "Hostels in Kathmandu" });
  });

  it("uses a real photo when there is one, and marks private pages noindex", () => {
    const metadata = pageMetadata({
      description: "x",
      image: { url: "https://media.softmato.com/a.jpg" },
      noindex: true,
      path: "/hostels/a",
      title: "A",
    });

    expect((metadata.openGraph?.images as Array<{ url: string }>)[0].url).toBe(
      "https://media.softmato.com/a.jpg",
    );
    expect(metadata.robots).toEqual(NOINDEX);
  });
});

describe("social card signing", () => {
  it("refuses text it did not sign", () => {
    const url = new URL(ogImagePath("Plans & Pricing", "Pricing"), "https://x.test");
    url.searchParams.set("t", "HostelPalika is shutting down");

    expect(verifiedOgText(url.searchParams)).toBeNull();
    expect(verifiedOgText(new URLSearchParams("t=Hello"))).toBeNull();
  });

  it("falls back to the plain card without a secret", () => {
    vi.stubEnv("JWT_ACCESS_SECRET", "");

    expect(ogImagePath("Anything")).toBe("/og");
  });
});

describe("shipped SEO copy", () => {
  it("passes its own schema, so saving the pre-filled editor never fails", () => {
    expect(seoSchema.safeParse(DEFAULT_SEO).success).toBe(true);
  });

  it("titles and describes every page, and every feature page names a real module", () => {
    for (const key of SEO_PAGE_KEYS) {
      expect(DEFAULT_SEO.pages[key].title, key).not.toBe("");
      expect(DEFAULT_SEO.pages[key].description, key).not.toBe("");
    }

    const moduleIds = new Set(DEFAULT_PLANS.modules.map((module) => module.id));
    for (const page of DEFAULT_SEO.modulePages) {
      expect(moduleIds.has(page.moduleId), page.moduleId).toBe(true);
    }

    const slugs = DEFAULT_SEO.modulePages.map((page) => page.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("fills the brand and the cheapest plan price", () => {
    const fill = seoFiller(DEFAULT_PLANS);

    expect(fill("{siteName} from {fromPrice}")).toBe("HostelPalika from NPR 999");
    const cleared = {
      ...DEFAULT_SEO,
      pages: { ...DEFAULT_SEO.pages, map: { description: "", title: "" } },
    };
    expect(resolveSeoPage(cleared, "map", fill).title).toBe(
      "Hostel Map of Nepal — Find a Hostel Near You",
    );
  });
});

describe("structured data", () => {
  it("cannot be closed early by owner-typed text", () => {
    const html = serializeJsonLd({ name: "</script><script>alert(1)</script>" });

    expect(html).not.toContain("</script>");
    expect(JSON.parse(html)).toEqual({ name: "</script><script>alert(1)</script>" });
  });

  it("states a rating only when there are reviews", () => {
    const base = {
      facilities: ["Wi-Fi"],
      location: { area: "Baneshwor", city: "Kathmandu" },
      name: "Education Light",
      photos: [],
      pricing: { monthlyRentMax: 12000, monthlyRentMin: 8000 },
      rooms: [{ monthlyRent: 8000, roomType: "Double" }],
      slug: "education-light",
    };

    const unrated = hostelJsonLd({ ...base, rating: { averageRating: 0, total: 0 } });
    expect(unrated.aggregateRating).toBeUndefined();
    expect(unrated.priceRange).toBe("NPR 8,000–NPR 12,000 per month");
    expect(unrated.url).toBe("https://hostelpalika.com/hostels/education-light");

    const rated = hostelJsonLd({ ...base, rating: { averageRating: 4.26, total: 7 } });
    expect(rated.aggregateRating).toMatchObject({ ratingValue: 4.3, reviewCount: 7 });
  });

  it("drops an empty FAQ and prices only real plans", () => {
    expect(faqJsonLd([])).toBeNull();

    const app = softwareApplicationJsonLd({
      description: "d",
      features: [],
      monthlyPrices: [3000, 8000, 5000, 0],
    });
    expect(app.offers).toMatchObject({ highPrice: 8000, lowPrice: 3000, offerCount: 3 });
  });

  it("cuts descriptions at a word", () => {
    expect(snippet("alpha beta gamma delta", 15)).toBe("alpha beta…");
    expect(snippet("short", 15)).toBe("short");
  });
});
