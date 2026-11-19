import "server-only";

import { cache } from "react";

import {
  guidePages,
  type GuideContent,
  type GuideLockedGroup,
  type GuidePageEntry,
  type GuideReader,
} from "@hostel/shared/guide/guide";

import { chapterToc } from "@/app/_components/guide/guide-toc";
import { serverApi } from "@/lib/server-api";

/**
 * The guide is private content (`packages/shared/src/guide/guide.ts`): pages ask
 * `GET /api/v1/guide` as the reader, so the API decides what they may read and
 * signs the pictures. Client components get titles and search lines for those
 * chapters only.
 */
export type GuidePayload = {
  guide: GuideContent;
  locked: GuideLockedGroup[];
  reader: GuideReader;
  updatedAt: string;
  version: string;
};

/** This reader's guide, once per request; null when the API cannot give it. */
export const loadGuide = cache(async (): Promise<GuidePayload | null> => {
  try {
    return await serverApi<GuidePayload>("/api/v1/guide", { session: true });
  } catch {
    return null;
  }
});

/** The public part, as a signed-out visitor gets it — for the sitemap and llms-full.txt. */
export async function loadPublicGuide(): Promise<GuidePayload | null> {
  try {
    return await serverApi<GuidePayload>("/api/v1/guide");
  } catch {
    return null;
  }
}

export type GuideNavGroup = {
  slug: string;
  label: string;
  intro: string;
  ne?: string;
  /** False: a locked part — the card asks them to sign in. */
  open: boolean;
  /** The part's first chapter: where sign-in sends them back to. */
  first: string;
  chapters: { href: string; id: string; ne?: string; title: string }[];
};

/** The sidebar and the overview cards: open parts with their chapters, then locked parts by name. */
export function guideNav(p: GuidePayload): GuideNavGroup[] {
  const open = p.guide.groups.map((g) => ({
    chapters: g.chapters.map((c) => ({ href: `/guide/${g.slug}/${c.id}`, id: c.id, ne: p.guide.ne.chapters[c.id]?.title, title: c.title })),
    first: `/guide/${g.slug}/${g.chapters[0].id}`,
    intro: g.intro,
    label: g.label,
    ne: p.guide.ne.groups[g.slug]?.label,
    open: true,
    slug: g.slug,
  }));
  const locked = p.locked.map((g) => ({
    chapters: [],
    first: g.first,
    intro: "",
    label: g.label,
    ne: g.labelNe ?? undefined,
    open: false,
    slug: g.slug,
  }));
  return [...open, ...locked];
}

export type GuideSearchEntry = { group: string; href: string; id: string; lines: string[]; summary: string; title: string };

/** Every searchable line of the chapters this reader may open. */
export function guideSearchIndex(p: GuidePayload): GuideSearchEntry[] {
  return guidePages(p.guide).map(({ chapter: c, group, href }) => ({
    group: group.label,
    href,
    id: c.id,
    lines: [c.summary, ...(c.body ?? []), ...(c.points ?? []), ...(c.steps ?? []), c.note?.body ?? "", c.flow?.caption ?? "", c.shot?.caption ?? ""].filter(Boolean),
    summary: c.summary,
    title: c.title,
  }));
}

export type GuideReaderPage = { href: string; title: string; toc: ReturnType<typeof chapterToc> };

/** What the reader's rail needs per chapter: the title and its "On this page". */
export function readerPages(pages: GuidePageEntry[]): GuideReaderPage[] {
  return pages.map((p) => ({ href: p.href, title: p.chapter.title, toc: chapterToc(p) }));
}
