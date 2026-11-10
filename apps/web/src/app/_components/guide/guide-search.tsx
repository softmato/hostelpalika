"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { GUIDE_PAGES } from "@hostel/shared/guide/guide";

import { ArrowRight, CornerDownLeft, Search } from "@/components/icons";
import { jumpToChapter } from "@/app/_components/guide/guide-toc";
import { cn } from "@/lib/utils";

type Page = (typeof GUIDE_PAGES)[number];

/** Every searchable line of a chapter, title first. */
const INDEX = GUIDE_PAGES.map((page) => {
  const c = page.chapter;
  const lines = [c.summary, ...(c.body ?? []), ...(c.steps ?? []), c.note?.body ?? "", c.flow?.caption ?? "", c.shot?.caption ?? ""].filter(Boolean);
  return { lines, page, title: c.title.toLowerCase(), group: page.group.label.toLowerCase() };
});

/** Shown before anything is typed: the questions people actually arrive with. */
const POPULAR = ["add-resident", "send-proof", "verify-payments", "how-bills-work", "expenses", "app-lock"];

function search(query: string) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) {
    return POPULAR.flatMap((id) => {
      const hit = INDEX.find((e) => e.page.chapter.id === id);
      return hit ? [{ page: hit.page, snippet: hit.page.chapter.summary }] : [];
    });
  }
  return INDEX.map((e) => {
    let score = 0;
    let snippet = "";
    for (const t of terms) {
      if (e.title.includes(t)) score += 10;
      if (e.group.includes(t)) score += 2;
      const line = e.lines.find((l) => l.toLowerCase().includes(t));
      if (line) {
        score += 3;
        snippet ||= cut(line, t);
      } else if (!e.title.includes(t)) {
        return null; // every word has to appear somewhere
      }
    }
    return { page: e.page, score, snippet: snippet || e.page.chapter.summary };
  })
    .filter((r): r is { page: Page; score: number; snippet: string } => r !== null)
    .sort((a, b) => b.score - a.score)
    .slice(0, 8);
}

/** About 110 characters around the first match. */
function cut(line: string, term: string) {
  const i = line.toLowerCase().indexOf(term);
  if (line.length <= 110) return line;
  const start = Math.max(0, i - 40);
  return (start > 0 ? "…" : "") + line.slice(start, start + 110) + (start + 110 < line.length ? "…" : "");
}

function Highlight({ text, query }: { text: string; query: string }): ReactNode {
  const terms = query.trim().split(/\s+/).filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!terms.length) return text;
  const parts = text.split(new RegExp(`(${terms.join("|")})`, "gi"));
  return parts.map((p, i) =>
    i % 2 ? (
      <mark className="rounded-sm bg-primary/15 px-0.5 text-foreground" key={i}>
        {p}
      </mark>
    ) : (
      p
    ),
  );
}

function isTyping(target: EventTarget | null) {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

/**
 * The guide's search: Ctrl/⌘+K or "/" anywhere on a guide page. Opens at the top
 * middle, sliding down over a blurred page (a click outside closes it); results update as you type; ↑ ↓ to move,
 * Enter to open, Esc to close. Everything runs on the page — no request per key.
 */
export function GuideSearch({ trigger }: { trigger: (open: () => void) => ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const results = useMemo(() => search(query), [query]);

  const show = () => {
    setQuery("");
    setActive(0);
    setClosing(false);
    setOpen(true);
  };
  const hide = () => {
    setClosing(true);
    window.setTimeout(() => {
      setOpen(false);
      setClosing(false);
    }, 200);
  };
  const go = (href: string) => {
    hide();
    if (!jumpToChapter(href)) router.push(href);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey)) || (e.key === "/" && !isTyping(e.target))) {
        e.preventDefault();
        show();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!open) return;
    input.current?.focus();
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = before;
    };
  }, [open]);

  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const onInputKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter" && results[active]) {
      e.preventDefault();
      go(results[active].page.href);
    } else if (e.key === "Escape") {
      hide();
    }
  };

  return (
    <>
      {trigger(show)}
      {/* Portaled to <body>: the sticky header's backdrop-filter would otherwise
          trap this fixed layer inside the header, blurring only the header and
          leaving the rest of the page unclickable-to-close. */}
      {open
        ? createPortal(
        <div
          aria-label="Search the guide"
          aria-modal="true"
          className="fixed inset-0 z-[60] px-4"
          role="dialog"
        >
          <button
            aria-label="Close search"
            className={cn(
              "absolute inset-0 cursor-default bg-background/40 backdrop-blur-md duration-300 ease-out",
              closing ? "animate-out fade-out" : "animate-in fade-in",
            )}
            onClick={hide}
            tabIndex={-1}
            type="button"
          />
          <div
            className={cn(
              "relative mx-auto mt-[12vh] max-w-xl overflow-hidden rounded-2xl border border-border bg-popover shadow-2xl shadow-black/10 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:animate-none",
              closing
                ? "animate-out fade-out slide-out-to-top-6 duration-200"
                : "animate-in fade-in slide-in-from-top-[12vh] duration-300",
            )}
          >
            <div className="flex items-center gap-3 border-b border-border px-4">
              <Search aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <input
                aria-activedescendant={results[active] ? `guide-hit-${active}` : undefined}
                aria-controls="guide-hits"
                className="h-14 w-full bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
                onKeyDown={onInputKey}
                placeholder="Search the guide — add resident, payment proof, late fine…"
                ref={input}
                role="combobox"
                aria-expanded="true"
                value={query}
              />
              <kbd className="hidden shrink-0 rounded-md border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground sm:block">
                Esc
              </kbd>
            </div>

            <ul className="max-h-[min(60vh,440px)] overflow-y-auto p-2" id="guide-hits" ref={list} role="listbox">
              {!query.trim() ? (
                <li className="px-3 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  Popular
                </li>
              ) : null}
              {results.map((r, i) => (
                <li
                  aria-selected={i === active}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-xl px-3 py-2.5 transition-colors duration-100",
                    i === active ? "bg-primary/[0.07]" : "hover:bg-muted/60",
                  )}
                  data-index={i}
                  id={`guide-hit-${i}`}
                  key={r.page.href}
                  onClick={() => go(r.page.href)}
                  onMouseMove={() => setActive(i)}
                  role="option"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-medium text-muted-foreground">{r.page.group.label}</p>
                    <p className="truncate text-sm font-semibold text-foreground">
                      <Highlight query={query} text={r.page.chapter.title} />
                    </p>
                    <p className="mt-0.5 line-clamp-2 text-[13px] leading-5 text-muted-foreground">
                      <Highlight query={query} text={r.snippet} />
                    </p>
                  </div>
                  <ArrowRight
                    aria-hidden
                    className={cn(
                      "mt-5 size-4 shrink-0 text-primary transition-all duration-150",
                      i === active ? "translate-x-0 opacity-100" : "-translate-x-1 opacity-0",
                    )}
                  />
                </li>
              ))}
              {query.trim() && !results.length ? (
                <li className="px-3 py-10 text-center text-sm text-muted-foreground">
                  Nothing for “{query}”. Try fewer words.
                </li>
              ) : null}
            </ul>

            <div className="flex items-center gap-4 border-t border-border px-4 py-2.5 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1">
                <kbd className="rounded border border-border px-1">↑</kbd>
                <kbd className="rounded border border-border px-1">↓</kbd> to move
              </span>
              <span className="flex items-center gap-1">
                <CornerDownLeft aria-hidden className="size-3" /> to open
              </span>
            </div>
          </div>
        </div>,
            document.body,
          )
        : null}
    </>
  );
}
