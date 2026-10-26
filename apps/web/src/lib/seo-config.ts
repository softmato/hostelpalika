import "server-only";

import type { Metadata } from "next";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

import { formatNpr } from "@/lib/json-ld";
import { pageMetadata, type PageSeo } from "@/lib/seo";
import { loadSiteConfig } from "@/lib/site-config-server";
import { DEFAULT_PLANS } from "@/modules/platform-config/plans.defaults";
import { DEFAULT_SEO, SEO_PAGE_ROUTES } from "@/modules/platform-config/seo.defaults";
import type {
  PlansConfig,
  SeoConfig,
  SeoPageKey,
} from "@/modules/platform-config/site-config.validation";

/**
 * The `seo` config section, ready to print: placeholders filled, and any title
 * or description an owner left blank replaced by the shipped one.
 */

export function cheapestMonthly(plans: PlansConfig) {
  const prices = plans.plans.map((plan) => plan.monthly).filter((price) => price > 0);
  const fallback = DEFAULT_PLANS.plans.map((plan) => plan.monthly);

  return Math.min(...(prices.length ? prices : fallback));
}

export type SeoFill = (text: string) => string;

export function seoFiller(plans: PlansConfig): SeoFill {
  const fromPrice = formatNpr(cheapestMonthly(plans));

  return (text) =>
    text.replace(/\{siteName\}/g, PLATFORM_NAME).replace(/\{fromPrice\}/g, fromPrice);
}

export function resolveSeoPage(seo: SeoConfig, key: SeoPageKey, fill: SeoFill) {
  const stored = seo.pages[key];
  const shipped = DEFAULT_SEO.pages[key];

  return {
    description: fill(stored?.description || shipped.description),
    title: fill(stored?.title || shipped.title),
  };
}

export async function loadSeo() {
  const config = await loadSiteConfig();
  const seo = config.seo ?? DEFAULT_SEO;
  const fill = seoFiller(config.plans);

  return { config, fill, seo };
}

/**
 * Metadata for a page whose words live in Website Config → SEO. `extra` carries
 * what only the page knows — `noindex`, a photo, an eyebrow for the card.
 */
export async function staticPageMetadata(
  key: SeoPageKey,
  extra: Partial<PageSeo> = {},
): Promise<Metadata> {
  const { fill, seo } = await loadSeo();
  const { description, title } = resolveSeoPage(seo, key, fill);

  return pageMetadata({
    description,
    path: SEO_PAGE_ROUTES[key].path,
    title,
    // The home title names the brand itself; everything else gets the template.
    titleIsAbsolute: key === "home",
    ...extra,
  });
}

/** The `/hostel-management-software` page, placeholders filled. */
export function resolveSoftwarePage(seo: SeoConfig, fill: SeoFill) {
  const page = seo.software.headline ? seo.software : DEFAULT_SEO.software;

  return {
    faq: page.faq.map((entry) => ({ answer: fill(entry.answer), question: fill(entry.question) })),
    headline: fill(page.headline),
    intro: page.intro.map(fill),
    sections: page.sections.map((section) => ({
      body: section.body.map(fill),
      icon: section.icon,
      title: fill(section.title),
    })),
    steps: page.steps.map((step) => ({ body: fill(step.body), title: fill(step.title) })),
    subtitle: fill(page.subtitle),
  };
}

/**
 * Feature pages joined to the plans catalogue they describe. A page whose module
 * was removed from the catalogue is dropped — it has nothing true left to say.
 */
export function resolveModulePages(seo: SeoConfig, plans: PlansConfig, fill: SeoFill) {
  return seo.modulePages.flatMap((page) => {
    const planModule = plans.modules.find((entry) => entry.id === page.moduleId);

    if (!planModule) {
      return [];
    }

    return [
      {
        description: fill(page.description) || planModule.description,
        headline: fill(page.headline),
        intro: page.intro.map(fill),
        module: planModule,
        services: plans.services
          .filter((service) => service.module === planModule.id)
          .map((service) => ({
            ...service,
            plan: plans.plans.find((plan) => plan.id === service.plan) ?? null,
          })),
        slug: page.slug,
      },
    ];
  });
}

export type ResolvedModulePage = ReturnType<typeof resolveModulePages>[number];

export function resolveComparison(seo: SeoConfig, slug: string, fill: SeoFill) {
  const comparison = seo.comparisons.find((entry) => entry.slug === slug);

  if (!comparison) {
    return null;
  }

  return {
    description: fill(comparison.description),
    faq: comparison.faq.map((entry) => ({
      answer: fill(entry.answer),
      question: fill(entry.question),
    })),
    intro: comparison.intro.map(fill),
    name: comparison.name,
    rows: comparison.rows.map((row) => ({
      label: fill(row.label),
      them: fill(row.them),
      us: fill(row.us),
    })),
    slug: comparison.slug,
    stayWith: comparison.stayWith.map(fill),
    title: fill(comparison.title) || `${PLATFORM_NAME} vs ${comparison.name}`,
  };
}

export type ResolvedComparison = NonNullable<ReturnType<typeof resolveComparison>>;
