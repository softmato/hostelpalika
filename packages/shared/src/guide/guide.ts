/**
 * The user guide's shape and rules — never its words.
 *
 * The guide is how we run a hostel, written down, and this repository is public.
 * So the content (chapters in English and Nepali, the tables, the pictures) lives
 * in the private R2 bucket as `guide/content.json` + `guide/pictures/*`, edited in
 * the gitignored `guide-content/` folder and uploaded with `scripts/guide-sync.ts`.
 * The web server and the Go server load it, keep only what the reader's role may
 * read (`guideForReader`), and sign each picture for a short time. Nothing here
 * may hold a sentence of the guide.
 *
 * Import-free apart from the brand name, so the Go port and the app can mirror it.
 */
import { PLATFORM_NAME } from "../brand/brand";

export type GuideRole = "owner" | "warden" | "resident" | "guardian" | "cook" | "visitor";

export interface GuidePicture {
  /** Stored as `/guide/<name>.webp`; a reader gets a signed URL instead. */
  src: string;
  caption: string;
  /** `food.webp` — set beside a signed `src`, so a client can cache by name. */
  name?: string;
}

export interface GuideLink {
  label: string;
  /** A site path, like `/hostel-admin/residents`. */
  href: string;
}

/** A part of the page rendered from code rather than prose (web and app map the slug). */
export type GuideWidget = "share-receipt" | "access-table" | "troubleshooting" | "auto-billing";

export interface GuideChapter {
  id: string;
  title: string;
  /** One line under the title: what this chapter answers. */
  summary: string;
  body?: string[];
  /** A bullet list (not a sequence): the parts of a screen, the roles. */
  points?: string[];
  steps?: string[];
  note?: { title: string; body: string };
  /** Where to do it: the screen's own name, so it stays English in Nepali too. */
  links?: GuideLink[];
  /** The same screen on a laptop and a phone. */
  shot?: GuidePicture;
  /** A numbered row of phone screens, one per step. */
  flow?: GuidePicture;
  widget?: GuideWidget;
  /** Who may read it, when fewer people than its group (see `canReadChapter`). */
  audience?: GuideRole[];
}

export interface GuideGroup {
  /** URL segment: `/guide/<slug>/<chapter id>`. */
  slug: string;
  /** Sidebar heading. */
  label: string;
  /** Who reads this group. */
  audience: GuideRole[];
  /** One line under the group heading. */
  intro: string;
  chapters: GuideChapter[];
}

/** One chapter in Nepali; every list has as many lines as the English one. */
export interface GuideChapterNe {
  title: string;
  summary: string;
  body?: string[];
  points?: string[];
  steps?: string[];
  note?: { title: string; body: string };
  /** Caption of the chapter's `flow` picture. */
  flow?: string;
  /** Caption of the chapter's `shot` picture. */
  shot?: string;
}

export interface GuideAccessRow {
  area: string;
  cells: Record<Exclude<GuideRole, "visitor">, string>;
}

export interface GuideTrouble {
  problem: string;
  fix: string;
}

/** The whole guide, as stored in R2 and as handed to one reader (trimmed). */
export interface GuideContent {
  groups: GuideGroup[];
  /** "Who can do what"; empty when the reader may not see that chapter. */
  access: GuideAccessRow[];
  /** "Fix a problem"; empty when the reader may not see that chapter. */
  trouble: GuideTrouble[];
  ne: {
    groups: Record<string, { label: string; intro: string }>;
    chapters: Record<string, GuideChapterNe>;
    access: { areas: Record<string, string>; cells: Record<string, string>; roles: Record<string, string> };
    trouble: GuideTrouble[];
  };
}

/** Who reads: one role, or `"all"` for the platform team. */
export type GuideReader = GuideRole | "all";

/** The account role (`Role` in `types/roles.ts`) → who it reads as. Anyone else reads as a visitor. */
const READER_BY_ROLE: Record<string, GuideReader> = {
  COOK: "cook",
  GUARDIAN: "guardian",
  HOSTEL_ADMIN: "owner",
  PLATFORM_AGENT: "all",
  PLATFORM_MODERATOR: "all",
  RESIDENT: "resident",
  SUPERADMIN: "all",
  WARDEN: "warden",
};

export function guideReaderForRole(role: string | null | undefined): GuideReader {
  return (role && READER_BY_ROLE[role]) || "visitor";
}

/** A part the reader may not open: its name and who it is for, never a chapter. */
export interface GuideLockedGroup {
  slug: string;
  label: string;
  labelNe: string | null;
  audience: GuideRole[];
  /** Its first chapter's page — where sign-in sends them back to. */
  first: string;
}

export function lockedGroups(content: GuideContent, reader: GuideReader): GuideLockedGroup[] {
  return content.groups
    .filter((g) => g.chapters.length > 0 && !g.chapters.some((c) => canReadChapter(reader, g, c)))
    .map((g) => ({
      audience: g.audience,
      first: `/guide/${g.slug}/${g.chapters[0].id}`,
      label: g.label,
      labelNe: content.ne.groups[g.slug]?.label ?? null,
      slug: g.slug,
    }));
}

/**
 * A signed-out visitor reads only the parts meant for the public, each role reads
 * its own parts, and the owner reads everything (they teach their staff).
 */
export function canReadChapter(reader: GuideReader, group: GuideGroup, chapter: GuideChapter) {
  return reader === "all" || reader === "owner" || (chapter.audience ?? group.audience).includes(reader);
}

export interface GuidePageEntry {
  chapter: GuideChapter;
  group: GuideGroup;
  href: string;
}

/** Every chapter in reading order, with its group and URL. */
export function guidePages(content: Pick<GuideContent, "groups">): GuidePageEntry[] {
  return content.groups.flatMap((group) =>
    group.chapters.map((chapter) => ({ chapter, group, href: `/guide/${group.slug}/${chapter.id}` })),
  );
}

export function guidePagesFor(content: Pick<GuideContent, "groups">, reader: GuideReader) {
  return guidePages(content).filter((p) => canReadChapter(reader, p.group, p.chapter));
}

export function findGuidePage(content: Pick<GuideContent, "groups">, groupSlug: string, chapterId: string) {
  return guidePages(content).find((p) => p.group.slug === groupSlug && p.chapter.id === chapterId) ?? null;
}

/**
 * The guide as one reader may see it: only the chapters they may open (a group
 * with none left is dropped), their Nepali, and the two tables only when their
 * chapters are open. This is what leaves the server — the API's `guide`.
 */
export function guideForReader(content: GuideContent, reader: GuideReader): GuideContent {
  const groups = content.groups
    .map((g) => ({ ...g, chapters: g.chapters.filter((c) => canReadChapter(reader, g, c)) }))
    .filter((g) => g.chapters.length > 0);
  const ids = new Set(groups.flatMap((g) => g.chapters.map((c) => c.id)));
  const table = ids.has("who-can-do-what");
  const trouble = ids.has("troubleshooting");
  return {
    access: table ? content.access : [],
    groups,
    ne: {
      access: table ? content.ne.access : { areas: {}, cells: {}, roles: {} },
      chapters: Object.fromEntries(Object.entries(content.ne.chapters).filter(([id]) => ids.has(id))),
      groups: Object.fromEntries(Object.entries(content.ne.groups).filter(([slug]) => groups.some((g) => g.slug === slug))),
      trouble: trouble ? content.ne.trouble : [],
    },
    trouble: trouble ? content.trouble : [],
  };
}

/** `/guide/food.webp` → `food.webp`: the picture's name in `guide/pictures/`. */
export function guidePictureName(src: string) {
  return src.slice(src.lastIndexOf("/") + 1);
}

/** The same guide with every picture's `src` swapped for `url(src)` (a signed link). */
export function withPictureUrls(content: GuideContent, url: (src: string) => string): GuideContent {
  const swap = (p: GuidePicture) => ({ ...p, name: guidePictureName(p.src), src: url(p.src) });
  return {
    ...content,
    groups: content.groups.map((g) => ({
      ...g,
      chapters: g.chapters.map((c) => ({ ...c, ...(c.flow ? { flow: swap(c.flow) } : {}), ...(c.shot ? { shot: swap(c.shot) } : {}) })),
    })),
  };
}

/** Stored text says `{platform}` wherever the product's name goes, so a rename needs no re-upload. */
export function parseGuideContent(raw: string): GuideContent {
  return JSON.parse(raw.replaceAll("{platform}", PLATFORM_NAME)) as GuideContent;
}

/**
 * What would show wrong on the page: a missing Nepali chapter or line, a repeated
 * id, a table without its Nepali. `scripts/guide-sync.ts` refuses to upload until
 * this is empty.
 */
export function guideProblems(content: GuideContent): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const lines = (v?: unknown[]) => v?.length ?? 0;
  for (const g of content.groups) {
    if (!content.ne.groups[g.slug]) out.push(`group ${g.slug}: no Nepali`);
    for (const c of g.chapters) {
      if (seen.has(c.id)) out.push(`chapter ${c.id}: id used twice`);
      seen.add(c.id);
      const ne = content.ne.chapters[c.id];
      if (!ne) {
        out.push(`chapter ${c.id}: no Nepali`);
        continue;
      }
      for (const k of ["body", "points", "steps"] as const) {
        if (lines(ne[k]) !== lines(c[k])) out.push(`chapter ${c.id}: ${k} has ${lines(ne[k])} Nepali lines, ${lines(c[k])} English`);
      }
      for (const k of ["note", "flow", "shot"] as const) {
        if (Boolean(ne[k]) !== Boolean(c[k])) out.push(`chapter ${c.id}: ${k} differs between English and Nepali`);
      }
    }
  }
  if (content.ne.trouble.length !== content.trouble.length) out.push("troubleshooting: Nepali rows differ");
  for (const row of content.access) {
    if (!content.ne.access.areas[row.area]) out.push(`access ${row.area}: no Nepali`);
    for (const cell of Object.values(row.cells)) if (cell !== "—" && !content.ne.access.cells[cell]) out.push(`access cell ${cell}: no Nepali`);
  }
  return out;
}

/** One chapter as Markdown — the whole-guide file for `/llms-full.txt`. */
export function chapterAsMarkdown(c: GuideChapter, heading = "#") {
  const out = [`${heading} ${c.title}`, "", `_${c.summary}_`, ""];
  c.body?.forEach((p) => out.push(p, ""));
  c.points?.forEach((pt) => out.push(`- ${pt}`));
  if (c.points) out.push("");
  c.steps?.forEach((st, i) => out.push(`${i + 1}. ${st}`));
  if (c.steps) out.push("");
  if (c.note) out.push(`> **${c.note.title}.** ${c.note.body}`, "");
  if (c.links) out.push(c.links.map((l) => `[${l.label}](${l.href})`).join(" · "), "");
  return out.join("\n").trimEnd();
}

/**
 * The guide as Markdown, as one reader may see it. `/llms-full.txt` asks as a
 * signed-out visitor, so only the public chapters ever leave as plain text.
 */
export function guideAsMarkdown(
  content: GuideContent,
  meta: { version: string; updatedAt: string },
  siteUrl = "",
  reader: GuideReader = "visitor",
) {
  const mine = guideForReader(content, reader);
  const out: string[] = [
    `# How to use ${PLATFORM_NAME}`,
    "",
    `Version ${meta.version} · Updated ${meta.updatedAt}. Pictures: ${siteUrl}/guide`,
    "",
  ];
  for (const s of mine.groups) {
    if (s.slug === "reference") continue;
    out.push(`## ${s.label}`, "", s.intro, "");
    for (const c of s.chapters) out.push(chapterAsMarkdown(c, "###"), "");
  }
  if (mine.access.length) {
    out.push("## Who can do what", "", "| Area | Owner | Warden | Resident | Guardian | Cook |", "|---|---|---|---|---|---|");
    for (const r of mine.access) {
      out.push(`| ${r.area} | ${r.cells.owner} | ${r.cells.warden} | ${r.cells.resident} | ${r.cells.guardian} | ${r.cells.cook} |`);
    }
    out.push("");
  }
  if (mine.trouble.length) {
    out.push("## Fix a problem", "");
    for (const t of mine.trouble) out.push(`- **${t.problem}.** ${t.fix}`);
  }
  return out.join("\n").trimEnd();
}
