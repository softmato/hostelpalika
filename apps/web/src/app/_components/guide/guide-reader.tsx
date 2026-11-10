"use client";

import { usePathname } from "next/navigation";
import { useEffect, useMemo, useRef, type ReactNode } from "react";

import { GUIDE_PAGES, chapterAsMarkdown } from "@hostel/shared/guide/guide";

import { CopyMarkdown } from "@/app/_components/guide/copy-markdown";
import { HostelRail, OnThisPage, PageUseful } from "@/app/_components/guide/guide-rail";
import { chapterToc } from "@/app/_components/guide/guide-toc";
import type { GuideHostel } from "@/lib/guide-hostels";

/** The section top that counts as "reading this chapter": just under the sticky bar. */
const READ_LINE = 120;

/**
 * The whole guide as one read. Scrolling into another chapter rewrites the URL in
 * place (no navigation), so the sidebar and "On this page" follow; opening a chapter
 * from the sidebar or search scrolls to it.
 */
export function GuideReader({ children, current, hostels }: { children: ReactNode; current: string; hostels: GuideHostel[] }) {
  const path = usePathname();
  const active = GUIDE_PAGES.find((p) => p.href === path) ?? GUIDE_PAGES.find((p) => p.href === current)!;
  const toc = useMemo(() => chapterToc(active), [active]);
  // The last URL this reader wrote itself, so it does not scroll to its own update.
  const written = useRef<string | null>(null);

  useEffect(() => {
    if (written.current === path) return;
    const el = document.querySelector(`[data-chapter="${path}"]`);
    if (el && path !== GUIDE_PAGES[0].href) el.scrollIntoView({ block: "start" });
  }, [path]);

  useEffect(() => {
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const sections = Array.from(document.querySelectorAll<HTMLElement>("[data-chapter]"));
        const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2;
        const hit = atBottom
          ? sections.at(-1)
          : sections.filter((s) => s.getBoundingClientRect().top <= READ_LINE).at(-1) ?? sections[0];
        const href = hit?.dataset.chapter;
        if (!href || href === window.location.pathname) return;
        const from = GUIDE_PAGES.find((p) => p.href === window.location.pathname);
        const to = GUIDE_PAGES.find((p) => p.href === href);
        written.current = href;
        window.history.replaceState(null, "", href);
        if (from && to) document.title = document.title.replace(from.chapter.title, to.chapter.title);
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, []);

  return (
    <div className="flex">
      <article className="min-w-0 flex-1 px-4 py-8 sm:px-8 lg:px-12 lg:py-10">
        <div className="mx-auto max-w-[780px]">{children}</div>
      </article>

      <aside className="hidden w-[340px] shrink-0 border-l border-border xl:block">
        <div className="thin-scrollbar sticky top-16 max-h-[calc(100dvh-4rem)] space-y-6 overflow-y-auto px-7 py-8">
          <p className="truncate text-xs font-medium text-primary">{active.chapter.title}</p>
          <OnThisPage items={toc} />
          <CopyMarkdown markdown={chapterAsMarkdown(active.chapter)} />
          <PageUseful key={active.href} />
          <HostelRail hostels={hostels} />
        </div>
      </aside>
    </div>
  );
}
