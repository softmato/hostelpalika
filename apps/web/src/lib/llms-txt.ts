import { PLATFORM_NAME, PLATFORM_VENDOR, PLATFORM_VENDOR_URL } from "@hostel/shared/brand/brand";

import { formatNpr } from "@/lib/json-ld";
import { ROLE_LINKS } from "@/lib/role-links";

/**
 * `/llms.txt` and `/llms-full.txt` — the site described in plain Markdown for
 * language-model tools, following the llmstxt.org layout (a title, a one-line
 * summary, then sections of links).
 *
 * ## Why it exists, and what it is not
 *
 * Answer engines and assistants that browse fetch a page and have to work out
 * from the HTML what the site is. These two files say it directly: what
 * HostelPalika is for each of its two audiences, which pages answer which
 * question, and — in the full file — the public facts of every listed hostel
 * and every plan, computed from the same data the pages render. No search
 * engine is known to rank on them and no assistant is promised to read them;
 * they are cheap, and they keep what an assistant says about the platform
 * tied to what the platform actually shows.
 *
 * Only public listing fields go in: name, type, place, starting rent, the
 * rating with its review count, and the page URL. No phone numbers or
 * addresses beyond the area — those stay on the hostel's own page.
 */

export type LlmsHostel = {
  area: string;
  city: string;
  listingTier: string | null;
  name: string;
  price: number;
  rating: number;
  reviews: number;
  slug: string;
  type: string;
};

export type LlmsData = {
  base: string;
  cities: Array<{
    areas: Array<{ count: number; name: string; slug: string }>;
    count: number;
    name: string;
    slug: string;
    types: Record<string, number>;
  }>;
  comparisons: Array<{ name: string; slug: string; title: string }>;
  features: Array<{ description: string; headline: string; slug: string }>;
  hostels: LlmsHostel[];
  modules: Array<{ description: string; name: string }>;
  near: Array<{ city: string; count: number; name: string; slug: string }>;
  plans: Array<{ badge: string | null; monthly: number; name: string }>;
  software: {
    faq: Array<{ answer: string; question: string }>;
    sections: Array<{ body: string[]; title: string }>;
  };
};

const ROLE_NOTES: Record<(typeof ROLE_LINKS)[number]["slug"], string> = {
  cooks: "the weekly menu, khata asks and meal photos",
  owners: "rooms, rent, payments, staff permissions, parents and the public listing",
  parents: "their own child's fees, notices, food and SOS alerts, invited by the child",
  residents: "pay rent with eSewa or Khalti and upload proof, receipts, statement PDF, menu, night status, complaints, SOS",
  wardens: "residents, payment checks, cash, food, notices, complaints, night status — only what the owner grants",
};

const TYPE_LABEL: Record<string, string> = {
  BOYS: "boys",
  CO_LIVING: "co-living",
  GIRLS: "girls",
};

const SUMMARY = `${PLATFORM_NAME} is a Nepal hostel platform with two sides: students and parents find and compare verified boys, girls and co-living hostels (rent, rooms, photos, residents' reviews), and hostel owners run their hostel on it — residents, rent billed in Bikram Sambat months, eSewa and Khalti payment checks, food, night attendance and parents — in one app with a login for every role.`;

function link(base: string, path: string, title: string, note?: string) {
  return `- [${title}](${base}${path})${note ? `: ${note}` : ""}`;
}

function typeCounts(types: Record<string, number>) {
  return Object.entries(types)
    .filter(([, count]) => count > 0)
    .map(([type, count]) => `${count} ${TYPE_LABEL[type] ?? type.toLowerCase()}`)
    .join(", ");
}

function badgeLine(plans: LlmsData["plans"]) {
  const badged = plans.filter((plan) => plan.badge);

  if (!badged.length) return null;

  return `${badged.map((plan) => `${plan.badge} (${plan.name} plan)`).join(" and ")} are directory badges a hostel gets with a paid plan. They place the hostel first in the default listing and on location pages; they are a paid placement, not a rating or a quality award.`;
}

export function buildLlmsTxt(data: LlmsData) {
  const { base } = data;
  const listed = data.cities.filter((city) => city.count > 0);
  const lines = [
    `# ${PLATFORM_NAME}`,
    "",
    `> ${SUMMARY}`,
    "",
    `Every hostel on ${PLATFORM_NAME} is checked by the team before it goes live, and reviews can only be written by residents who stayed there. Prices are in Nepali rupees (NPR) per month. ${PLATFORM_NAME} is a product of ${PLATFORM_VENDOR}, Kathmandu (${PLATFORM_VENDOR_URL}).`,
    "",
    "## Find a hostel (students and parents)",
    "",
    link(base, "/hostels", "All hostels in Nepal", "search and filter by city, area, type, rent, room and food"),
    link(base, "/hostels/in", "Hostels by city"),
    ...listed.map((city) =>
      link(
        base,
        `/hostels/in/${city.slug}`,
        `Hostels in ${city.name}`,
        `${city.count} verified (${typeCounts(city.types)})`,
      ),
    ),
    ...(data.near.length ? [link(base, "/hostels/near", "Hostels near colleges")] : []),
    link(base, "/map", "Hostel map of Nepal"),
    link(base, "/compare", "Compare hostels side by side"),
    link(base, "/how-booking-works", "How booking a bed works"),
    "",
    "## Run a hostel (owners)",
    "",
    link(base, "/hostel-management-software", "Hostel management software for Nepal", "what it does, how each role uses it, FAQ"),
    link(base, "/features", "Features"),
    link(base, "/plans-pricing", "Plans and pricing"),
    link(base, "/register-hostel", "List your hostel"),
    ...data.comparisons.map((comparison) => link(base, `/vs/${comparison.slug}`, comparison.title)),
    "",
    "## Each person in a hostel",
    "",
    ...ROLE_LINKS.map((role) =>
      link(base, `/for/${role.slug}`, `For ${role.label.toLowerCase()}`, ROLE_NOTES[role.slug]),
    ),
    "",
    "## Company",
    "",
    link(base, "/about", `About ${PLATFORM_NAME}`),
    link(base, "/contact", "Contact"),
    link(base, "/privacy", "Privacy policy"),
    link(base, "/terms", "Terms of service"),
    "",
    "## Optional",
    "",
    link(base, "/llms-full.txt", "Full text", "every listed hostel, plan and owner FAQ in one file"),
    link(base, "/sitemap.xml", "Sitemap"),
    "",
  ];

  return lines.join("\n");
}

export function buildLlmsFullTxt(data: LlmsData) {
  const { base } = data;
  const lines: string[] = [buildLlmsTxt(data).trimEnd(), "", "---", ""];

  lines.push("## Hostels listed today", "");
  if (!data.hostels.length) {
    lines.push("No hostels are listed yet.", "");
  }
  for (const hostel of data.hostels) {
    const facts = [
      `${TYPE_LABEL[hostel.type] ?? "co-living"} hostel in ${[hostel.area, hostel.city].filter(Boolean).join(", ")}`,
      hostel.price > 0 ? `rent from ${formatNpr(hostel.price)} a month` : null,
      hostel.reviews > 0
        ? `rated ${hostel.rating.toFixed(1)}/5 from ${hostel.reviews} resident review${hostel.reviews === 1 ? "" : "s"}`
        : "no reviews yet",
      hostel.listingTier ? `${hostel.listingTier} (paid placement)` : null,
    ].filter(Boolean);
    lines.push(`- [${hostel.name}](${base}/hostels/${hostel.slug}): ${facts.join("; ")}`);
  }

  const areaPages = data.cities.flatMap((city) =>
    city.areas
      .filter((area) => area.count > 0)
      .map((area) =>
        link(base, `/hostels/in/${city.slug}/${area.slug}`, `Hostels in ${area.name}, ${city.name}`, `${area.count} verified`),
      ),
  );
  if (areaPages.length) {
    lines.push("", "## Hostels by area", "", ...areaPages);
  }

  if (data.near.length) {
    lines.push(
      "",
      "## Hostels near colleges",
      "",
      "Distance is a straight line from each hostel's map pin, within 1.5 km.",
      "",
      ...data.near.map((place) =>
        link(
          base,
          `/hostels/near/${place.slug}`,
          `Hostels near ${place.name}${place.city ? `, ${place.city}` : ""}`,
          `${place.count} verified`,
        ),
      ),
    );
  }

  lines.push("", "## Plans for hostel owners", "");
  for (const plan of data.plans) {
    lines.push(
      `- ${plan.name}: ${formatNpr(plan.monthly)} a month${plan.badge ? `, includes the ${plan.badge} directory badge` : ""}`,
    );
  }
  const badges = badgeLine(data.plans);
  lines.push(
    "",
    `Paying for six months or a year costs less per month. Residents and parents never pay for ${PLATFORM_NAME}. Full details: ${base}/plans-pricing`,
    ...(badges ? ["", badges] : []),
  );

  if (data.modules.length) {
    lines.push("", "## What the software covers", "");
    for (const entry of data.modules) {
      lines.push(`- ${entry.name}: ${entry.description}`);
    }
    for (const feature of data.features) {
      lines.push(link(base, `/features/${feature.slug}`, feature.headline, feature.description));
    }
  }

  if (data.software.sections.length) {
    lines.push("", "## How it works for a hostel", "");
    for (const section of data.software.sections) {
      lines.push(`### ${section.title}`, "", ...section.body.flatMap((paragraph) => [paragraph, ""]));
    }
  }

  if (data.software.faq.length) {
    lines.push("## Owner questions", "");
    for (const entry of data.software.faq) {
      lines.push(`### ${entry.question}`, "", entry.answer, "");
    }
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
