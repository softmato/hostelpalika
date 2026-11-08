import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { FeatureModulePage } from "@/app/_components/public-software-pages";
import { JsonLd } from "@/components/json-ld";
import { breadcrumbJsonLd, itemListJsonLd } from "@/lib/json-ld";
import { NOINDEX, pageMetadata } from "@/lib/seo";
import { loadSeo, resolveModulePages } from "@/lib/seo-config";
import { DEFAULT_SEO } from "@/lib/platform-config/seo.defaults";

type PageParams = {
  params: Promise<{ module: string }>;
};

/**
 * One plan module, named the way owners search for it — "Hostel Fee Collection
 * & Billing Software" rather than "Fees & Payments". The shipped pages
 * prerender; a page added in Website Config → SEO resolves on request.
 */
export const dynamicParams = true;

export function generateStaticParams() {
  return DEFAULT_SEO.modulePages.map((page) => ({ module: page.slug }));
}

async function loadModulePage(slug: string) {
  const { config, fill, seo } = await loadSeo();
  const modules = resolveModulePages(seo, config.plans, fill);
  const entry = modules.find((candidate) => candidate.slug === slug) ?? null;

  return { entry, others: modules.filter((candidate) => candidate.slug !== slug) };
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { module: slug } = await params;
  const { entry } = await loadModulePage(slug);

  if (!entry) {
    return { robots: NOINDEX, title: "Feature not found" };
  }

  return pageMetadata({
    description: entry.description,
    eyebrow: entry.module.name,
    path: `/features/${entry.slug}`,
    title: entry.headline,
  });
}

export default async function FeatureModuleRoute({ params }: PageParams) {
  const { module: slug } = await params;
  const { entry, others } = await loadModulePage(slug);

  if (!entry) {
    notFound();
  }

  return (
    <>
      <JsonLd
        data={[
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Features", path: "/features" },
            { name: entry.headline, path: `/features/${entry.slug}` },
          ]),
          itemListJsonLd(
            entry.headline,
            entry.services.map((service) => ({
              name: service.name,
              path: `/plans-pricing/${service.slug}`,
            })),
          ),
        ]}
      />
      <FeatureModulePage entry={entry} others={others} />
    </>
  );
}
