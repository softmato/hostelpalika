import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

import { getPlan, getService, getServiceModule } from "@/app/_components/plans-catalog";
import { PublicServiceDetailPage } from "@/app/_components/public-service-detail-page";
import { JsonLd } from "@/components/json-ld";
import { breadcrumbJsonLd, formatNpr } from "@/lib/json-ld";
import { NOINDEX, pageMetadata, snippet } from "@/lib/seo";
import { loadSeo } from "@/lib/seo-config";
import { DEFAULT_PLANS } from "@/lib/platform-config/plans.defaults";

type PageParams = {
  params: Promise<{ service: string }>;
};

/**
 * The catalogue is owner-editable, so the set of service pages is not known at
 * build time: a service added in Platform → Website Config → Plans & Pricing has
 * to resolve on the first request rather than wait for a deploy. The shipped
 * catalogue is still prerendered — it needs no database to enumerate and covers
 * every slug the sitemap and the cards point at on a fresh install — and
 * anything beyond it renders on demand under the public layout's revalidation.
 * A slug that is in neither is still a 404, never an empty page.
 */
export const dynamicParams = true;

export function generateStaticParams() {
  return DEFAULT_PLANS.services.map((service) => ({ service: service.slug }));
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { service: slug } = await params;
  const { config } = await loadSeo();
  const catalog = config.plans;
  const service = getService(catalog, slug);

  if (!service) {
    return { robots: NOINDEX, title: "Service not found" };
  }

  const plan = getPlan(catalog, service.plan);
  const priced = plan
    ? ` Part of ${PLATFORM_NAME} ${plan.name}, from ${formatNpr(plan.monthly)} a month.`
    : "";

  return pageMetadata({
    description: snippet(`${service.blurb}${priced}`, 180),
    eyebrow: getServiceModule(catalog, service.module)?.name ?? "Feature",
    path: `/plans-pricing/${service.slug}`,
    title: /hostel/i.test(service.name) ? service.name : `${service.name} for Hostels`,
  });
}

export default async function ServiceDetailPage({ params }: PageParams) {
  const { service: slug } = await params;
  const { config, seo } = await loadSeo();
  const catalog = config.plans;
  const service = getService(catalog, slug);

  if (!service) {
    notFound();
  }

  const path = `/plans-pricing/${service.slug}`;
  const featurePage = seo.modulePages.find((page) => page.moduleId === service.module);
  const crumbs = featurePage
    ? [
        { name: "Home", path: "/" },
        { name: "Features", path: "/features" },
        { name: featurePage.headline, path: `/features/${featurePage.slug}` },
        { name: service.name, path },
      ]
    : [
        { name: "Home", path: "/" },
        { name: "Plans & Pricing", path: "/plans-pricing" },
        { name: service.name, path },
      ];

  return (
    <>
      <JsonLd data={breadcrumbJsonLd(crumbs)} />
      <PublicServiceDetailPage catalog={catalog} service={service} />
    </>
  );
}
