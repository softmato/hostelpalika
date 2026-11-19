import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import { canReadChapter, findGuidePage, type GuideLockedGroup, type GuideRole } from "@hostel/shared/guide/guide";

import { GuideArticle } from "@/app/_components/guide/guide-article";
import { JsonLd } from "@/components/json-ld";
import { Lock } from "@/components/icons";
import { loadGuide } from "@/lib/guide-access";
import { absoluteUrl, breadcrumbJsonLd, organizationId } from "@/lib/json-ld";
import { loadGuideHostels } from "@/lib/guide-hostels";

type Params = Promise<{ chapter: string; group: string }>;
type Found = NonNullable<ReturnType<typeof findGuidePage>>;

/** The chapter in the reader's own guide, or the locked part it sits in. */
async function lookUp(group: string, chapter: string) {
  const payload = await loadGuide();
  const found = payload ? findGuidePage(payload.guide, group, chapter) : null;
  const locked = payload?.locked.find((g) => g.slug === group) ?? null;
  return { found, locked, payload };
}

/** What a signed-out visitor may read — the only chapters search engines and link previews see. */
const isPublic = (found: Found) => canReadChapter("visitor", found.group, found.chapter);

const WHO: Record<GuideRole, string> = {
  cook: "cooks",
  guardian: "guardians",
  owner: "hostel owners",
  resident: "residents",
  visitor: "visitors",
  warden: "wardens",
};

/** A part this reader may not open: who it is for, and a way to sign in. No words from it. */
function Locked({ href, locked }: { href: string; locked: GuideLockedGroup }) {
  const who = locked.audience.map((r) => WHO[r]);
  const list = who.length > 1 ? `${who.slice(0, -1).join(", ")} and ${who.at(-1)}` : who[0];
  return (
    <div className="px-4 py-16 sm:px-8 lg:px-12">
      <div className="mx-auto max-w-md rounded-2xl border border-border p-8 text-center">
        <span className="mx-auto flex size-11 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Lock aria-hidden className="size-5" />
        </span>
        <h1 className="mt-4 font-heading text-xl font-bold text-foreground">This part is for {list}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Sign in with that account to read it.</p>
        <Link
          className="mt-6 inline-flex h-10 items-center rounded-full bg-primary px-5 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          href={`/login?next=${encodeURIComponent(href)}`}
        >
          Sign in
        </Link>
      </div>
    </div>
  );
}

/** The description Google shows: the summary, then the first sentence of the chapter. */
function describe(found: Found) {
  const c = found.chapter;
  const first = (c.body?.[0] ?? c.steps?.[0] ?? "").split(/(?<=\.)\s/)[0];
  return `${c.summary} ${first}`.trim().slice(0, 300);
}

function Unavailable() {
  return (
    <p className="px-4 py-16 text-center text-sm text-muted-foreground sm:px-8">
      The guide could not be loaded. Try again in a minute.
    </p>
  );
}

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { chapter, group } = await params;
  const { found } = await lookUp(group, chapter);
  if (!found || !isPublic(found)) return { robots: { follow: false, index: false }, title: "Guide" };
  const path = found.href;
  // Public chapters' pictures also sit in /public/guide, so link previews can fetch them.
  const pic = found.chapter.flow ?? found.chapter.shot;
  const image = pic?.name ? `/guide/${pic.name}` : "/guide/finding-your-way.webp";
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
  const { found, locked, payload } = await lookUp(group, chapter);
  if (!payload) return <Unavailable />;
  if (!found && locked) return <Locked href={`/guide/${group}/${chapter}`} locked={locked} />;
  if (!found) notFound();

  const hostels = await loadGuideHostels();
  const { updatedAt } = payload;
  const modified = new Date(updatedAt);
  const c = found.chapter;
  const url = absoluteUrl(found.href);
  const pic = c.flow ?? c.shot;
  const image = pic?.name ? `/guide/${pic.name}` : undefined;

  return (
    <>
      {isPublic(found) ? (
      <JsonLd
        data={[
          breadcrumbJsonLd([
            { name: "Guide", path: "/guide" },
            { name: found.group.label, path: `/guide/${group}/${found.group.chapters[0].id}` },
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
      ) : null}
      <GuideArticle guide={payload.guide} hostels={hostels} href={found.href} updatedAt={updatedAt} />
    </>
  );
}
