import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import { GUIDE_GROUPS } from "@hostel/shared/guide/guide";
import { GUIDE_NE_GROUPS } from "@hostel/shared/guide/guide-ne";

import { L } from "@/app/_components/guide/guide-l";
import { HostelRail } from "@/app/_components/guide/guide-rail";
import { BrandMark, BrandWordmark } from "@/components/brand-mark";
import { JsonLd } from "@/components/json-ld";
import { ChevronRight } from "@/components/icons";
import { loadGuideHostels } from "@/lib/guide-hostels";
import { absoluteUrl, breadcrumbJsonLd } from "@/lib/json-ld";
import { loadSiteConfig } from "@/lib/site-config-server";

const DESCRIPTION = `The ${PLATFORM_NAME} user guide: how hostel owners, wardens, residents, guardians and cooks use the app and the website — adding residents, bills, payments, expenses, food and safety, step by step.`;

export const metadata: Metadata = {
  alternates: { canonical: "/guide" },
  description: DESCRIPTION,
  openGraph: { description: DESCRIPTION, images: ["/mockups/warden-dashboard.webp"], title: `${PLATFORM_NAME} user guide`, url: "/guide" },
  title: "User guide",
};

/** The picture on each part's card — the screen that part is mostly about. */
const COVER: Record<string, string> = {
  cook: "/guide/cook.webp",
  guardian: "/guide/payments.webp",
  owner: "/guide/finding-your-way.webp",
  resident: "/guide/resident-tour.webp",
  start: "/guide/admin-vs-warden.webp",
  visitor: "/guide/visitor.webp",
  warden: "/guide/warden-permissions.webp",
};

/** `/guide` — the front door: the banner, the version line, one card per part. */
export default async function GuidePage() {
  const [{ legal }, hostels] = await Promise.all([loadSiteConfig(), loadGuideHostels(8)]);
  const version = legal.guide?.version ?? "1.0";
  const updatedAt = legal.guide?.updatedAt ?? "10 November 2026";
  const parts = GUIDE_GROUPS.filter((g) => g.slug !== "reference");

  return (
    <div className="px-4 py-8 sm:px-8 lg:px-12 lg:py-10">
      <JsonLd
        data={[
          breadcrumbJsonLd([{ name: "Guide", path: "/guide" }]),
          {
            "@context": "https://schema.org",
            "@type": "CollectionPage",
            description: DESCRIPTION,
            hasPart: GUIDE_GROUPS.flatMap((g) =>
              g.chapters.map((c) => ({ "@type": "TechArticle", headline: c.title, url: absoluteUrl(`/guide/${g.slug}/${c.id}`) })),
            ),
            name: `${PLATFORM_NAME} user guide`,
            url: absoluteUrl("/guide"),
          },
        ]}
      />

      <div className="mx-auto max-w-[1040px]">
        {/* The banner: a quiet ground, the HP mark huge and cropped on the right,
            the wordmark laid over it bottom-left. */}
        <section className="relative min-h-[300px] overflow-hidden rounded-3xl border border-border bg-muted/40 sm:min-h-[400px]">
          <div aria-hidden className="pointer-events-none absolute -left-24 -top-28 size-80 rounded-full bg-primary/15 blur-3xl" />
          <div aria-hidden className="pointer-events-none absolute -bottom-32 right-1/4 size-96 rounded-full bg-primary/10 blur-3xl" />
          <div
            aria-hidden
            className="pointer-events-none absolute -right-14 -top-6 flex h-52 rotate-[-8deg] sm:-right-20 sm:top-1/2 sm:h-[420px] sm:-translate-y-1/2"
          >
            <BrandMark adaptive className="h-full drop-shadow-[0_40px_60px_rgba(10,138,75,0.25)]" />
          </div>
          <div aria-hidden className="absolute inset-0 bg-gradient-to-r from-background/90 via-background/40 to-transparent" />

          <div className="relative flex min-h-[inherit] flex-col justify-end p-7 sm:p-12">
            <p className="font-mono text-xs text-muted-foreground">User guide</p>
            <h1 className="mt-3">
              <span className="sr-only">{PLATFORM_NAME} user guide</span>
              <BrandWordmark className="sm:hidden" height={40} />
              <BrandWordmark className="hidden sm:inline-flex" height={68} />
            </h1>
            <span aria-hidden className="mt-5 block h-1 w-24 rounded-full bg-primary" />
            <p className="mt-5 max-w-xs text-foreground/75">Every screen, for every role. Step by step.</p>
          </div>
        </section>

        <p className="mt-8 font-mono text-xs text-muted-foreground">
          <span className="text-primary">#</span> v{version} · Last updated {updatedAt}
        </p>
        <p className="mt-3 max-w-2xl font-heading text-xl font-semibold leading-snug text-foreground sm:text-2xl">
          How owners, wardens, residents, guardians and cooks run a hostel on {PLATFORM_NAME}.
        </p>
        <p className="sr-only">{DESCRIPTION}</p>

        <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {parts.map((g) => (
            <Link
              className="group overflow-hidden rounded-2xl border border-border transition-all duration-200 ease-out hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-lg hover:shadow-primary/5"
              href={`/guide/${g.slug}/${g.chapters[0].id}`}
              key={g.slug}
              // Each chapter page carries the whole guide; don't prefetch seven copies.
              prefetch={false}
            >
              <span className="relative block aspect-[3/2] overflow-hidden bg-muted/40">
                <Image
                  alt=""
                  className="object-cover object-top transition-transform duration-300 ease-out group-hover:scale-[1.03]"
                  fill
                  sizes="(min-width: 1024px) 330px, (min-width: 640px) 50vw, 100vw"
                  src={COVER[g.slug] ?? "/guide/finding-your-way.webp"}
                />
              </span>
              <span className="flex items-center justify-between border-t border-border px-4 py-3">
                <span>
                  <span className="block font-heading font-bold text-foreground"><L en={g.label} ne={GUIDE_NE_GROUPS[g.slug]?.label} /></span>
                  <span className="block text-xs text-muted-foreground">
                    {g.chapters.length} {g.chapters.length === 1 ? "chapter" : "chapters"}
                  </span>
                </span>
                <ChevronRight aria-hidden className="size-4 text-muted-foreground transition-transform duration-200 group-hover:translate-x-0.5 group-hover:text-primary" />
              </span>
              <span className="sr-only"><L en={g.intro} ne={GUIDE_NE_GROUPS[g.slug]?.intro} /></span>
            </Link>
          ))}
        </div>

        {hostels.length ? (
          <div className="mt-12 border-t border-border pt-8">
            <HostelRail hostels={hostels} wide />
          </div>
        ) : null}
      </div>
    </div>
  );
}
