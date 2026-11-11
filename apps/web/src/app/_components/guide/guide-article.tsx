import Image from "next/image";
import Link from "next/link";

import { GUIDE_ACCESS, GUIDE_PAGES, GUIDE_TROUBLE, type GuidePicture } from "@hostel/shared/guide/guide";
import { GUIDE_NE, GUIDE_NE_ACCESS, GUIDE_NE_GROUPS, GUIDE_NE_TROUBLE, GUIDE_NE_UI, type GuideChapterNe } from "@hostel/shared/guide/guide-ne";

import { L } from "@/app/_components/guide/guide-l";
import { GuideReader } from "@/app/_components/guide/guide-reader";
import { chapterKey, type GuidePageEntry } from "@/app/_components/guide/guide-toc";
import { ShareReceiptSteps } from "@/app/_components/share-receipt-steps";
import { ChevronRight, House } from "@/components/icons";
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

function AccessTable() {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead className="bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="px-4 py-3 font-semibold"><L en="Area" ne={GUIDE_NE_UI.area} /></th>
            {ROLES.map((r) => (
              <th className="px-4 py-3 font-semibold capitalize" key={r}>
                <L en={r} ne={GUIDE_NE_ACCESS.roles[r]} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {GUIDE_ACCESS.map((row) => (
            <tr key={row.area}>
              <td className="px-4 py-3 font-medium text-foreground"><L en={row.area} ne={GUIDE_NE_ACCESS.areas[row.area]} /></td>
              {ROLES.map((r) => (
                <td className={row.cells[r] === "—" ? "px-4 py-3 text-muted-foreground/50" : "px-4 py-3 text-foreground/80"} key={r}>
                  <L en={row.cells[r]} ne={GUIDE_NE_ACCESS.cells[row.cells[r]]} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Trouble() {
  return (
    <dl className="divide-y divide-border rounded-2xl border border-border">
      {GUIDE_TROUBLE.map((t, i) => (
        <div className="px-5 py-4" key={t.problem}>
          <dt className="font-semibold text-foreground"><L en={t.problem} ne={GUIDE_NE_TROUBLE[i]?.problem} /></dt>
          <dd className="mt-1 text-[15px] leading-7 text-foreground/75"><L en={t.fix} ne={GUIDE_NE_TROUBLE[i]?.fix} /></dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One chapter. Visible: breadcrumb, title, one line, the pictures. On the chapter
 * the URL names (`own`), the full text (paragraphs, steps, notes) stays in the DOM
 * as sr-only for search engines and AI readers; the other chapters leave it out so
 * no URL repeats the whole guide. A chapter with no picture shows its steps.
 */
/** The chapter's words: paragraphs, steps and the note, in one language. */
function Words({ c, lang, visual, k }: { c: Pick<GuideChapterNe, "body" | "note" | "steps">; k: string; lang: "en" | "ne"; visual: boolean }) {
  return (
    <div className={lang === "ne" ? "guide-ne space-y-4" : "guide-en space-y-4"} lang={lang === "ne" ? "ne" : undefined}>
      {c.body?.map((p) => <p key={p}>{p}</p>)}
      {c.steps ? (
        <section className="scroll-mt-24" id={lang === "en" ? `${k}-steps` : undefined}>
          <h3 className={visual ? "" : "mb-3 font-heading text-lg font-bold text-foreground"}>{lang === "ne" ? GUIDE_NE_UI.steps : "Steps"}</h3>
          <ol className={visual ? "" : "space-y-3"}>
            {c.steps.map((s, i) => (
              <li className={visual ? "" : "flex gap-3"} key={s}>
                {visual ? null : (
                  <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                    {i + 1}
                  </span>
                )}
                <span>{s}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
      {c.note ? (
        <p>
          <strong>{c.note.title}.</strong> {c.note.body}
        </p>
      ) : null}
    </div>
  );
}

function Chapter({ own, page, first }: { first: boolean; own: boolean; page: GuidePageEntry }) {
  const { chapter: c, group } = page;
  const ne = GUIDE_NE[c.id];
  // A part not yet in Nepali reads in English under the Nepali switch.
  const neWords = { body: ne?.body ?? c.body, note: ne?.note ?? c.note, steps: ne?.steps ?? c.steps };
  const k = chapterKey(page);
  const visual = Boolean(c.flow || c.shot || c.widget);
  const Title = own ? "h1" : "h2";

  return (
    <section className={first ? "scroll-mt-16" : "mt-16 scroll-mt-16 border-t border-border pt-12"} data-chapter={page.href}>
      <nav aria-label="Breadcrumb" className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
        <Link aria-label="Guide home" className="hover:text-foreground" href="/guide" title={GUIDE_NE_UI.guideHome}>
          <House className="size-4" />
        </Link>
        <ChevronRight aria-hidden className="size-3.5" />
        <span><L en={group.label} ne={GUIDE_NE_GROUPS[group.slug]?.label} /></span>
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
        {c.widget === "access-table" ? <AccessTable /> : null}
        {c.widget === "troubleshooting" ? <Trouble /> : null}
        {c.shot ? <Figure caption={ne?.shot} id={`${k}-screen`} label="On web and app" picture={c.shot} priority={own && !c.flow} /> : null}
      </div>

      {visual && !own ? null : (
        <div className={visual ? "sr-only" : "mt-6 text-[15.5px] leading-[1.8] text-foreground/80"}>
          <Words c={c} k={k} lang="en" visual={visual} />
          <Words c={neWords} k={k} lang="ne" visual={visual} />
        </div>
      )}
    </section>
  );
}

/**
 * The guide from a chapter's URL: every chapter in reading order on one page,
 * opened at this one. The reader keeps the URL, sidebar and rail on the chapter
 * in view.
 */
export function GuideArticle({ href, hostels, updatedAt }: { hostels: GuideHostel[]; href: string; updatedAt: string }) {
  const ownKey = chapterKey(GUIDE_PAGES.find((p) => p.href === href)!);

  return (
    <GuideReader current={href} hostels={hostels}>
      {GUIDE_PAGES.map((p, i) => (
        <Chapter first={i === 0} key={p.href} own={p.href === href} page={p} />
      ))}
      {/* Land on the opened chapter before first paint, not after hydration. Inside a
          div's HTML so it runs once from the server page and React never renders a
          <script> (a dev error on client navigation; the reader scrolls then). */}
      <div
        dangerouslySetInnerHTML={{
          __html: `<script>(function(){var e=document.getElementById(${JSON.stringify(ownKey)});if(e&&${JSON.stringify(href !== GUIDE_PAGES[0].href)})e.closest("[data-chapter]").scrollIntoView();})()</script>`,
        }}
        hidden
        suppressHydrationWarning
      />
      <p className="mt-12 border-t border-border pt-6 font-mono text-[11px] text-muted-foreground"><L en="Last updated" ne={GUIDE_NE_UI.lastUpdated} /> {updatedAt}</p>
    </GuideReader>
  );
}
