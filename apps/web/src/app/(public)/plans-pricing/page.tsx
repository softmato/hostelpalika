import type { Metadata } from "next";

import { PublicPlansPricingPage } from "@/app/_components/public-plans-pricing-page";
import { JsonLd } from "@/components/json-ld";
import { breadcrumbJsonLd, softwareApplicationJsonLd } from "@/lib/json-ld";
import { loadSeo, resolveSeoPage, staticPageMetadata } from "@/lib/seo-config";

export function generateMetadata(): Promise<Metadata> {
  return staticPageMetadata("plansPricing", { eyebrow: "Plans & Pricing" });
}

export default async function PlansPricingPage() {
  const { config, fill, seo } = await loadSeo();

  return (
    <>
      <JsonLd
        data={[
          softwareApplicationJsonLd({
            description: resolveSeoPage(seo, "software", fill).description,
            features: config.plans.modules.map((module) => module.name),
            monthlyPrices: config.plans.plans.map((plan) => plan.monthly),
          }),
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Plans & Pricing", path: "/plans-pricing" },
          ]),
        ]}
      />
      <PublicPlansPricingPage trialDays={config.trialDays} />
    </>
  );
}
