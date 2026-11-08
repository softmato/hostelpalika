import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ComparisonPage } from "@/app/_components/public-software-pages";
import { JsonLd } from "@/components/json-ld";
import { breadcrumbJsonLd, faqJsonLd } from "@/lib/json-ld";
import { NOINDEX, pageMetadata } from "@/lib/seo";
import { loadSeo, resolveComparison } from "@/lib/seo-config";
import { DEFAULT_SEO } from "@/lib/platform-config/seo.defaults";

type PageParams = {
  params: Promise<{ slug: string }>;
};

/** "HostelPalika vs Excel", "HostelPalika vs a hostel register book" — see `seoComparisonSchema`. */
export const dynamicParams = true;

export function generateStaticParams() {
  return DEFAULT_SEO.comparisons.map((comparison) => ({ slug: comparison.slug }));
}

export async function generateMetadata({ params }: PageParams): Promise<Metadata> {
  const { slug } = await params;
  const { fill, seo } = await loadSeo();
  const comparison = resolveComparison(seo, slug, fill);

  if (!comparison) {
    return { robots: NOINDEX, title: "Comparison not found" };
  }

  return pageMetadata({
    description: comparison.description,
    eyebrow: "Compare",
    path: `/vs/${comparison.slug}`,
    title: comparison.title,
  });
}

export default async function ComparisonRoute({ params }: PageParams) {
  const { slug } = await params;
  const { fill, seo } = await loadSeo();
  const comparison = resolveComparison(seo, slug, fill);

  if (!comparison) {
    notFound();
  }

  return (
    <>
      <JsonLd
        data={[
          breadcrumbJsonLd([
            { name: "Home", path: "/" },
            { name: "Hostel management software", path: "/hostel-management-software" },
            { name: comparison.title, path: `/vs/${comparison.slug}` },
          ]),
          faqJsonLd(comparison.faq),
        ]}
      />
      <ComparisonPage
        comparison={comparison}
        others={seo.comparisons
          .filter((other) => other.slug !== comparison.slug)
          .map((other) => ({ href: `/vs/${other.slug}`, name: other.name }))}
      />
    </>
  );
}
