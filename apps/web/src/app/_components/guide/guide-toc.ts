import type { GUIDE_PAGES } from "@hostel/shared/guide/guide";

export type GuidePageEntry = (typeof GUIDE_PAGES)[number];

/** Every chapter sits on one long page, so its anchors carry the chapter's key. */
export function chapterKey(p: GuidePageEntry) {
  return `${p.group.slug}-${p.chapter.id}`;
}

/**
 * On the reader every chapter is already on the page, so opening one is a scroll
 * plus a URL rewrite — no navigation and no fetch of another 280 KB copy of the
 * guide. False when the chapter is not on this page (e.g. from /guide), so the
 * caller navigates as usual.
 */
export function jumpToChapter(href: string) {
  const el = document.querySelector(`[data-chapter="${href}"]`);
  if (!el) return false;
  el.scrollIntoView({ block: "start" });
  window.history.replaceState(null, "", href);
  return true;
}

/** "On this page" for one chapter — the server ids and the rail's links share this. */
export function chapterToc(p: GuidePageEntry) {
  const c = p.chapter;
  const k = chapterKey(p);
  const visual = Boolean(c.flow || c.shot || c.widget);
  return [
    { id: k, label: "Overview" },
    ...(c.flow ? [{ id: `${k}-flow`, label: "Step by step" }] : []),
    ...(c.widget === "share-receipt" ? [{ id: `${k}-walkthrough`, label: "Share a receipt" }] : []),
    ...(c.shot ? [{ id: `${k}-screen`, label: "On web and app" }] : []),
    ...(!visual && c.steps ? [{ id: `${k}-steps`, label: "Steps" }] : []),
  ];
}
