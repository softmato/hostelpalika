import Image from "next/image";
import Link from "next/link";

import { guidePages, type GuideContent, type GuideLink, type GuidePicture } from "@hostel/shared/guide/guide";
import { GUIDE_NE_UI, type GuideChapterNe } from "@hostel/shared/guide/guide-ne";

import { AutoBillingDemo } from "@/app/_components/guide/guide-auto-billing";
import { L } from "@/app/_components/guide/guide-l";
import { GuideReader } from "@/app/_components/guide/guide-reader";
import { chapterKey, type GuidePageEntry } from "@/app/_components/guide/guide-toc";
import { ShareReceiptSteps } from "@/app/_components/share-receipt-steps";
import { ArrowUpRight, ChevronRight, House } from "@/components/icons";
import { readerPages } from "@/lib/guide-access";
import type { GuideHostel } from "@/lib/guide-hostels";

const ROLES = ["owner", "warden", "resident", "guardian", "cook"] as const;

/** A picture in a soft frame, like a code block in a docs site. */
function Figure({ caption, id, label, picture, priority }: { caption?: string; id: string; label: string; picture: GuidePicture; priority?: boolean }) {
  return (
    <section aria-label={label} className="scroll-mt-24" id={id}>
      <figure className="overflow-hidden rounded-2xl border border-border bg-muted/30">
        <Image
          alt={picture.caption}
          className="h-auto w-full"
          height={1024}
          priority={priority}
          src={picture.src}
          // Already-compressed WebP (70–100 KB). Skips the image optimizer, which
          // stalls on some of the 40 parallel requests a guide page makes; six
          // stalled sockets froze every picture after them.
          unoptimized
          width={1536}
        />
        <figcaption className="border-t border-border bg-background px-4 py-2.5 text-[13px] text-muted-foreground">
          <L en={picture.caption} ne={caption} />
        </figcaption>
      </figure>
    </section>
  );
}

function AccessTable({ guide }: { guide: GuideContent }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-semibold"><L en="Area" ne={GUIDE_NE_UI.area} /></th>
            {ROLES.map((r) => (
              <th className="px-4 py-3 font-semibold capitalize" key={r}>
                <L en={r} ne={guide.ne.access.roles[r]} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {guide.access.map((row) => (
            <tr key={row.area}>
              <td className="px-4 py-3 font-medium text-foreground"><L en={row.area} ne={guide.ne.access.areas[row.area]} /></td>
              {ROLES.map((r) => (
                <td className={row.cells[r] === "—" ? "px-4 py-3 text-muted-foreground/50" : "px-4 py-3 text-foreground/80"} key={r}>
                  <L en={row.cells[r]} ne={guide.ne.access.cells[row.cells[r]]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Trouble({ guide }: { guide: GuideContent }) {
  return (
    <dl className="divide-y divide-border rounded-2xl border border-border">
      {guide.trouble.map((t, i) => (
        <div className="px-5 py-4" key={t.problem}>
          <dt className="font-semibold text-foreground"><L en={t.problem} ne={guide.ne.trouble[i]?.problem} /></dt>
          <dd className="mt-1 text-[15px] leading-7 text-foreground/75"><L en={t.fix} ne={guide.ne.trouble[i]?.fix} /></dd>
        </div>
      ))}
    </dl>
  );
}

/** The chapter's words: paragraphs, bullets, steps and the note, in one language. */
function Words({ c, lang, k }: { c: Pick<GuideChapterNe, "body" | "note" | "points" | "steps">; k: string; lang: "en" | "ne" }) {
  return (
    <div className={lang === "ne" ? "guide-ne space-y-4" : "guide-en space-y-4"} lang={lang === "ne" ? "ne" : undefined}>
      {c.body?.map((p) => <p key={p}>{p}</p>)}
      {c.points ? (
        <ul className="space-y-2">
          {c.points.map((pt) => (
            <li className="flex gap-3" key={pt}>
              <span aria-hidden className="mt-[0.7em] size-1.5 shrink-0 rounded-full bg-primary" />
              <span>{pt}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {c.steps ? (
        <section className="scroll-mt-24" id={lang === "en" ? `${k}-steps` : undefined}>
          <h3 className="mb-3 font-heading text-lg font-bold text-foreground">{lang === "ne" ? GUIDE_NE_UI.steps : "Steps"}</h3>
          <ol className="space-y-3">
            {c.steps.map((s, i) => (
              <li className="flex gap-3" key={s}>
                <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                  {i + 1}
                </span>
                <span>{s}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {c.note ? (
        <p className="rounded-xl border-l-4 border-primary bg-primary/5 px-4 py-3">
          <strong>{c.note.title}.</strong> {c.note.body}
        </p>
      ) : null}
    </div>
  );
}

/** "Where to do it": each opens the screen in a new tab, so the guide stays open beside it. */
function Links({ links }: { links: GuideLink[] }) {
  return (
    <div className="mt-5 flex flex-wrap gap-2">
      {links.map((l) => (
        <a
          className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/5 px-3.5 py-1.5 text-sm font-semibold text-primary hover:bg-primary/10"
          href={l.href}
          key={l.href + l.label}
          rel="noopener noreferrer"
          target="_blank"
        >
          {l.label}
          <ArrowUpRight aria-hidden className="size-3.5" />
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      ))}
    </div>
  );
}

/** One chapter: breadcrumb, title, one line, the pictures, then the words and where to do it. */
function Chapter({ first, guide, own, page }: { first: boolean; guide: GuideContent; own: boolean; page: GuidePageEntry }) {
  const { chapter: c, group } = page;
  const ne = guide.ne.chapters[c.id];
  // A part not yet in Nepali reads in English under the Nepali switch.
  const neWords = { body: ne?.body ?? c.body, note: ne?.note ?? c.note, points: ne?.points ?? c.points, steps: ne?.steps ?? c.steps };
  const k = chapterKey(page);
  const Title = own ? "h1" : "h2";

  return (
    <section className={first ? "scroll-mt-16" : "mt-16 scroll-mt-16 border-t border-border pt-12"} data-chapter={page.href}>
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <Link aria-label="Guide home" className="hover:text-foreground" href="/guide" title={GUIDE_NE_UI.guideHome}>
          <House className="size-4" />
        </Link>
        <ChevronRight aria-hidden className="size-3.5" />
        <span><L en={group.label} ne={guide.ne.groups[group.slug]?.label} /></span>
        <ChevronRight aria-hidden className="size-3.5" />
        <span className="font-medium text-primary"><L en={c.title} ne={ne?.title} /></span>
      </nav>

      <header className="scroll-mt-20" id={k}>
        <Title className="mt-5 font-heading text-3xl font-bold tracking-tight text-foreground sm:text-4xl"><L en={c.title} ne={ne?.title} /></Title>
        <p className="mt-3 text-[16px] text-muted-foreground"><L en={c.summary} ne={ne?.summary} /></p>
      </header>

      <div className="mt-8 space-y-8">
        {c.flow ? <Figure caption={ne?.flow} id={`${k}-flow`} label="Step by step" picture={c.flow} priority={own} /> : null}
        {c.widget === "share-receipt" ? (
          <section aria-label="Share a receipt" className="scroll-mt-24" id={`${k}-walkthrough`}>
            <ShareReceiptSteps open />
          </section>
        ) : null}
        {c.widget === "access-table" ? <AccessTable guide={guide} /> : null}
        {c.widget === "troubleshooting" ? <Trouble guide={guide} /> : null}
        {c.widget === "auto-billing" ? <AutoBillingDemo /> : null}
        {c.shot ? <Figure caption={ne?.shot} id={`${k}-screen`} label="On web and app" picture={c.shot} priority={own && !c.flow} /> : null}
      </div>

      {/* Visible on every chapter, under the pictures (owner, 2026-11-16: "use clean
          bullets / paragraphs to make them understand"). Was sr-only beside a picture. */}
      <div className="mt-6 text-[15.5px] leading-[1.8] text-foreground/80">
        <Words c={c} k={k} lang="en" />
        <Words c={neWords} k={k} lang="ne" />
      </div>
      {c.links ? <Links links={c.links} /> : null}
    </section>
  );
}

/**
 * The guide from a chapter's URL: every chapter this reader may open, in reading
 * order on one page, opened at this one. The reader keeps the URL, sidebar and
 * rail on the chapter in view.
 */
export function GuideArticle({
  guide,
  href,
  hostels,
  updatedAt,
}: {
  /** The reader's own guide, from the API: only chapters they may open, pictures signed. */
  guide: GuideContent;
  hostels: GuideHostel[];
  href: string;
  updatedAt: string;
}) {
  const pages = guidePages(guide);
  const ownKey = chapterKey(pages.find((p) => p.href === href)!);

  return (
    <GuideReader current={href} hostels={hostels} pages={readerPages(pages)}>
      {pages.map((p, i) => (
        <Chapter first={i === 0} guide={guide} key={p.href} own={p.href === href} page={p} />
      ))}
      {/* Land on the opened chapter before first paint, not after hydration. Inside a
          div's HTML so it runs once from the server page and React never renders a
          <script> (a dev error on client navigation; the reader scrolls then). */}
      <div
        dangerouslySetInnerHTML={{
          __html: `<script>(function(){var e=document.getElementById(${JSON.stringify(ownKey)});if(e&&${JSON.stringify(href !== pages[0].href)})e.closest("[data-chapter]").scrollIntoView();})()</script>`,
        }}
        hidden
        suppressHydrationWarning
      />
      <p className="mt-12 border-t border-border pt-6 font-mono text-[11px] text-muted-foreground"><L en="Last updated" ne={GUIDE_NE_UI.lastUpdated} /> {updatedAt}</p>
    </GuideReader>
  );
}
