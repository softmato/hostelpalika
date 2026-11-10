import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import { GUIDE_PAGES, findGuidePage } from "@hostel/shared/guide/guide";

import { GuideArticle } from "@/app/_components/guide/guide-article";
import { JsonLd } from "@/components/json-ld";
import { absoluteUrl, breadcrumbJsonLd, organizationId } from "@/lib/json-ld";
import { loadGuideHostels } from "@/lib/guide-hostels";
import { loadSiteConfig } from "@/lib/site-config-server";

type Params = Promise<{ chapter: string; group: string }>;

export function generateStaticParams() {
  return GUIDE_PAGES.map((p) => ({ chapter: p.chapter.id, group: p.group.slug }));
}

export const dynamicParams = false;

/** The description Google shows: the summary, then the first sentence of the chapter. */
function describe(found: NonNullable<ReturnType<typeof findGuidePage>>) {
  const c = found.chapter;
  const first = (c.body?.[0] ?? c.steps?.[0] ?? "").split(/(?<=\.)\s/)[0];
  return `${c.summary} ${first}`.trim().slice(0, 300);
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { chapter, group } = await params;
  const found = findGuidePage(group, chapter);
  if (!found) return {};
  const path = found.href;
  const image = found.chapter.flow?.src ?? found.chapter.shot?.src ?? "/guide/finding-your-way.webp";
  const description = describe(found);
  return {
    alternates: { canonical: path },
    description,
    openGraph: {
      description,
      images: [{ height: 1024, url: image, width: 1536 }],
      title: `${found.chapter.title} — ${PLATFORM_NAME} guide`,
      type: "article",
      url: path,
    },
    title: `${found.chapter.title} · Guide`,
  };
}

export default async function GuideChapterPage({ params }: { params: Params }) {
  const { chapter, group } = await params;
  const found = findGuidePage(group, chapter);
  if (!found) notFound();

  const [{ legal }, hostels] = await Promise.all([loadSiteConfig(), loadGuideHostels()]);
  const updatedAt = legal.guide?.updatedAt ?? "10 November 2026";
  const modified = new Date(updatedAt);
  const c = found.chapter;
  const url = absoluteUrl(found.href);
  const image = c.flow?.src ?? c.shot?.src;

  return (
    <>
      <JsonLd
        data={[
          breadcrumbJsonLd([
            { name: "Guide", path: "/guide" },
            { name: found.group.label, path: GUIDE_PAGES.find((p) => p.group.slug === group)!.href },
            { name: c.title, path: found.href },
          ]),
          {
            "@context": "https://schema.org",
            "@type": "TechArticle",
            ...(Number.isNaN(modified.getTime()) ? {} : { dateModified: modified.toISOString() }),
            description: describe(found),
            headline: c.title,
            ...(image ? { image: absoluteUrl(image) } : {}),
            inLanguage: "en",
            isPartOf: { "@type": "CollectionPage", name: `${PLATFORM_NAME} user guide`, url: absoluteUrl("/guide") },
            mainEntityOfPage: url,
            publisher: { "@id": organizationId() },
          },
          c.steps
            ? {
                "@context": "https://schema.org",
                "@type": "HowTo",
                name: c.title,
                step: c.steps.map((text, i) => ({ "@type": "HowToStep", position: i + 1, text })),
                url,
              }
            : null,
        ]}
      />
      <GuideArticle hostels={hostels} href={found.href} updatedAt={updatedAt} />
    </>
  );
}
