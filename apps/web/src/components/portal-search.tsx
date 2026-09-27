"use client";

import { ArrowUpRight, CornerDownLeft, Search } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fieldSlug, type PortalSearchEntry } from "@/lib/portal-nav";
import { cn } from "@/lib/utils";

type PortalTone = "platform" | "admin" | "resident" | "guardian" | "team" | "cook" | "provider";

const TEAM_TONE = {
  active: "bg-role-team-soft/70",
  focus: "focus-within:border-role-team/40 focus-within:ring-role-team/15",
  text: "text-role-team",
};

const toneStyles: Record<PortalTone, { active: string; focus: string; text: string }> = {
  admin: {
    active: "bg-role-admin-soft/70",
    focus: "focus-within:border-role-admin/40 focus-within:ring-role-admin/15",
    text: "text-role-admin",
  },
  guardian: {
    active: "bg-role-guardian-soft/70",
    focus: "focus-within:border-role-guardian/40 focus-within:ring-role-guardian/15",
    text: "text-role-guardian",
  },
  platform: {
    active: "bg-role-platform-soft/70",
    focus: "focus-within:border-role-platform/40 focus-within:ring-role-platform/15",
    text: "text-role-platform",
  },
  resident: {
    active: "bg-role-resident-soft/70",
    focus: "focus-within:border-role-resident/40 focus-within:ring-role-resident/15",
    text: "text-role-resident",
  },
  team: TEAM_TONE,
  cook: TEAM_TONE,
  provider: TEAM_TONE,
};

function normalize(value: string) {
  return value.trim().toLowerCase();
}

/**
 * Weighted match so an exact label ("Payments") always outranks a page that
 * merely mentions the word in its description. With an empty query we still
 * return everything, ranked by nav order, so focusing the field shows a useful
 * jump list rather than a blank dropdown.
 */
function scoreEntry(entry: PortalSearchEntry, query: string, order: number) {
  if (!query) {
    return 100 - order;
  }

  const label = normalize(entry.label);
  const description = normalize(entry.description);
  const group = normalize(entry.group);
  const href = normalize(entry.href);

  let score = 0;

  if (label === query) score += 160;
  else if (label.startsWith(query)) score += 90;
  else if (label.includes(query)) score += 65;

  if (description.includes(query)) score += 30;
  if (group.includes(query)) score += 22;
  if (href.includes(query)) score += 14;

  for (const keyword of entry.keywords) {
    const value = normalize(keyword);
    if (value === query) score += 50;
    else if (value.startsWith(query)) score += 28;
    else if (value.includes(query)) score += 16;
  }

  return score;
}

const INPUT = "input, select, textarea";
const CONTROL = `${INPUT}, button, [role=switch]`;
const FLASH = ["rounded-md", "ring-2", "ring-role-platform/40", "ring-offset-4", "ring-offset-background"];

function pageOf(entry: PortalSearchEntry) {
  return entry.href.split("?")[0];
}

/**
 * The block holding `field` — the first text in `<main>` that slugs to it, after
 * the `section` heading when there is one — climbed to its `<label>` or the row
 * that holds its control.
 */
function findField(field: string, section: string | null) {
  const main = document.querySelector("main");
  if (!main) return null;

  const nodes: Text[] = [];
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);

  const slugs = nodes.map((node) => fieldSlug(node.data));
  const from = section ? slugs.indexOf(section) : 0;
  if (from < 0) return null;

  let hit = slugs.indexOf(field, from);
  if (hit < 0) hit = slugs.findIndex((slug, index) => index >= from && slug.startsWith(field));
  if (hit < 0) return null;

  for (let element = nodes[hit].parentElement, depth = 0; element && depth < 5; depth += 1) {
    if (element.matches("label") || element.querySelector(CONTROL)) return element;
    element = element.parentElement;
  }

  return nodes[hit].parentElement;
}

/**
 * Follows a `?field=` deep link: waits (up to 3 s) for the page and its data to
 * land on the right tab, then scrolls the field into view, focuses it and
 * flashes a ring round it. Returns a cancel for effects.
 */
export function revealField(href: string) {
  const target = new URL(href, window.location.origin);
  const field = target.searchParams.get("field");
  if (!field) return undefined;

  const section = target.searchParams.get("in");
  const tab = target.searchParams.get("tab");
  const deadline = Date.now() + 3000;
  const timer = window.setInterval(() => {
    const here = new URL(window.location.href);
    // Until the URL has moved, the old page is still up — and may have a field of the same name.
    const landed = here.pathname === target.pathname && here.searchParams.get("tab") === tab;
    const block = landed ? findField(field, section) : null;
    if (!block && Date.now() < deadline) return;

    window.clearInterval(timer);
    if (!block) return;

    block.scrollIntoView({ behavior: "smooth", block: "center" });
    const control = block.matches(CONTROL)
      ? block
      : (block.querySelector<HTMLElement>(INPUT) ?? block.querySelector<HTMLElement>(CONTROL));
    control?.focus({ preventScroll: true });
    block.classList.add(...FLASH);
    window.setTimeout(() => block.classList.remove(...FLASH), 1600);
  }, 100);

  return () => window.clearInterval(timer);
}

export function PortalSearch({
  className,
  entries,
  placeholder = "Search...",
  tone = "platform",
}: {
  className?: string;
  entries: PortalSearchEntry[];
  placeholder?: string;
  tone?: PortalTone;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const styles = toneStyles[tone];

  const normalizedQuery = normalize(query);

  const results = useMemo(() => {
    const ranked = entries
      .map((entry, index) => ({
        entry,
        score: scoreEntry(entry, normalizedQuery, index),
      }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, 10)
      .map((item) => item.entry);
    // Each page's hits sit together, pages in the order of their best hit.
    const pages = [...new Set(ranked.map(pageOf))];

    return pages.flatMap((page) => ranked.filter((entry) => pageOf(entry) === page));
  }, [entries, normalizedQuery]);

  // Reset the highlight whenever the result set changes underneath it.
  const [resultKey, setResultKey] = useState("");
  const nextResultKey = results.map((entry) => entry.id).join("|");
  if (resultKey !== nextResultKey) {
    setResultKey(nextResultKey);
    setActiveIndex(0);
  }

  // Collapse the palette after a navigation lands.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setQuery("");
    setOpen(false);
  }

  useEffect(() => {
    function handlePointerDown(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    function handleShortcut(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleShortcut);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleShortcut);
    };
  }, []);

  const openEntry = useCallback(
    (href: string) => {
      setOpen(false);
      setQuery("");
      inputRef.current?.blur();
      router.push(href);
      revealField(href);
    },
    [router],
  );

  return (
    <div className={cn("relative min-w-0 flex-1", className)} ref={containerRef}>
      <div
        className={cn(
          "flex h-9 items-center rounded-full border border-slate-200 bg-slate-50/80 px-3 shadow-sm transition focus-within:ring-2 dark:border-border dark:bg-muted/30",
          styles.focus,
        )}
      >
        <Search className="mr-2 size-3.5 shrink-0 text-slate-400" />
        <input
          aria-label="Search this portal"
          className="w-full bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
          onChange={(event) => {
            setQuery(event.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              inputRef.current?.blur();
              return;
            }

            if (event.key === "ArrowDown") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((current) =>
                results.length === 0 ? 0 : (current + 1) % results.length,
              );
              return;
            }

            if (event.key === "ArrowUp") {
              event.preventDefault();
              setOpen(true);
              setActiveIndex((current) =>
                results.length === 0
                  ? 0
                  : (current - 1 + results.length) % results.length,
              );
              return;
            }

            if (event.key === "Enter" && results[activeIndex]) {
              event.preventDefault();
              openEntry(results[activeIndex].href);
            }
          }}
          placeholder={placeholder}
          ref={inputRef}
          type="text"
          value={query}
        />
        <kbd className="ml-2 hidden shrink-0 rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[10px] font-semibold text-slate-400 sm:inline-block dark:border-border dark:bg-card">
          ⌘K
        </kbd>
      </div>

      {open ? (
        <div className="absolute left-0 right-0 top-[calc(100%+0.5rem)] z-50 overflow-hidden rounded-xl border border-border bg-popover shadow-xl">
          <div className="border-b border-border/70 bg-muted/30 px-3 py-2">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              Quick navigation
            </p>
            <p className="mt-0.5 text-[12px] text-foreground">
              {normalizedQuery
                ? `${results.length} match${results.length === 1 ? "" : "es"} for "${query.trim()}"`
                : "Jump to any tab, report, or configuration screen."}
            </p>
          </div>

          {results.length > 0 ? (
            <div className="no-scrollbar max-h-[20rem] overflow-y-auto p-1.5">
              {results.map((entry, index) => (
                <Fragment key={entry.id}>
                  {entry.field && (index === 0 || pageOf(results[index - 1]) !== pageOf(entry)) ? (
                    <p className="px-2.5 pb-1 pt-2 text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">
                      {entry.group}
                    </p>
                  ) : null}
                  <button
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                      activeIndex === index ? styles.active : "hover:bg-muted/60",
                    )}
                    onClick={() => openEntry(entry.href)}
                    onMouseEnter={() => setActiveIndex(index)}
                    type="button"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[13px] font-semibold text-foreground">
                          {entry.label}
                        </span>
                        {entry.field ? null : (
                          <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                            {entry.group}
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-4 text-muted-foreground">
                        {entry.description}
                      </p>
                    </div>
                    {activeIndex === index ? (
                      <CornerDownLeft
                        className={cn("mt-0.5 size-3.5 shrink-0", styles.text)}
                      />
                    ) : (
                      <ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-muted-foreground/60" />
                    )}
                  </button>
                </Fragment>
              ))}
            </div>
          ) : (
            <p className="px-3 py-5 text-center text-[12.5px] text-muted-foreground">
              Nothing matches “{query.trim()}”.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
