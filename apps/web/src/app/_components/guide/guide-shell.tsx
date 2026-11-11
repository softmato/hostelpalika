"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ComponentType, type ReactNode } from "react";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import { GUIDE_GROUPS } from "@hostel/shared/guide/guide";
import { GUIDE_NE, GUIDE_NE_GROUPS } from "@hostel/shared/guide/guide-ne";

import { L } from "@/app/_components/guide/guide-l";
import { GUIDE_LANG_SCRIPT, GuideLangSwitch } from "@/app/_components/guide/guide-lang";
import { GuideSearch } from "@/app/_components/guide/guide-search";
import { jumpToChapter } from "@/app/_components/guide/guide-toc";
import { BrandMark } from "@/components/brand-mark";
import {
  Building2,
  ChefHat,
  ChevronRight,
  HelpCircle,
  Heart,
  MapPin,
  Menu,
  Search,
  ShieldCheck,
  Sparkles,
  User,
} from "@/components/icons";
import { useSiteConfig } from "@/components/site-config-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/** One icon per part, so each role reads as its own section at a glance. */
const GROUP_ICON: Record<string, ComponentType<{ className?: string }>> = {
  cook: ChefHat,
  guardian: Heart,
  owner: Building2,
  reference: HelpCircle,
  resident: User,
  start: Sparkles,
  visitor: MapPin,
  warden: ShieldCheck,
};

const NAV = [
  { href: "/guide", label: "Guide" },
  { href: "/hostels", label: "Find hostels" },
  { href: "/plans-pricing", label: "Pricing" },
  { href: "/get-app", label: "Get the app" },
];

function Sidebar({ onPick }: { onPick?: () => void }) {
  const path = usePathname();
  const current = GUIDE_GROUPS.find((g) => path.startsWith(`/guide/${g.slug}/`))?.slug ?? "start";
  // One group open at a time; opening another closes the rest.
  const [open, setOpen] = useState<string | null>(current);
  // Follow the page into another group (search, prev/next) without an effect.
  const [seen, setSeen] = useState(current);
  if (seen !== current) {
    setSeen(current);
    setOpen(current);
  }

  return (
    <nav aria-label="Guide">
      <Link
        className={cn("block px-3 pb-4 font-heading text-xl font-bold", path === "/guide" ? "text-primary" : "text-foreground")}
        href="/guide"
        onClick={onPick}
      >
        Overview
      </Link>
      <ul className="divide-y divide-border border-y border-border">
        {GUIDE_GROUPS.map((group) => {
          const Icon = GROUP_ICON[group.slug] ?? Sparkles;
          const isOpen = open === group.slug;
          return (
            <li key={group.slug}>
              <button
                aria-expanded={isOpen}
                className="flex w-full items-center gap-2.5 px-3 py-3 text-left text-[14px] font-semibold text-foreground transition-colors hover:text-primary"
                onClick={() => setOpen(isOpen ? null : group.slug)}
                type="button"
              >
                <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-4" />
                </span>
                <span className="flex-1"><L en={group.label} ne={GUIDE_NE_GROUPS[group.slug]?.label} /></span>
                <ChevronRight
                  aria-hidden
                  className={cn("size-4 text-muted-foreground transition-transform duration-200 ease-out", isOpen && "rotate-90")}
                />
              </button>
              <div
                className={cn(
                  "grid transition-[grid-template-rows,opacity] duration-200 ease-out",
                  isOpen ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
                )}
                inert={!isOpen}
              >
                <ul className="space-y-0.5 overflow-hidden pb-3 pl-3">
                  {group.chapters.map((c) => {
                    const href = `/guide/${group.slug}/${c.id}`;
                    const active = path === href;
                    return (
                      <li key={c.id}>
                        <Link
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "block rounded-xl border px-3 py-2 text-[13.5px] transition-colors duration-150",
                            active
                              ? "border-primary/40 bg-primary/[0.06] font-medium text-primary"
                              : "border-transparent text-foreground/70 hover:bg-muted/60 hover:text-foreground",
                          )}
                          href={href}
                          onClick={(e) => {
                            if (!e.metaKey && !e.ctrlKey && !e.shiftKey && jumpToChapter(href)) e.preventDefault();
                            onPick?.();
                          }}
                          prefetch={false}
                        >
                          <L en={c.title} ne={GUIDE_NE[c.id]?.title} />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The guide's frame: version pill and search in a slim top bar, the parts of the
 * guide as collapsible groups on the left (one per role), and the page. Pages fade
 * in on navigation (`animate-page-in`, off for reduced motion).
 */
export function GuideShell({ children }: { children: ReactNode }) {
  const { legal } = useSiteConfig();
  const path = usePathname();
  const [menu, setMenu] = useState(false);
  const version = legal.guide?.version ?? "1.0";

  return (
    <div className="min-h-dvh bg-background">
      {/* The language before first paint. Inside a div's HTML so React never renders a <script>. */}
      <div dangerouslySetInnerHTML={{ __html: `<script>${GUIDE_LANG_SCRIPT}</script>` }} hidden suppressHydrationWarning />
      <header className="sticky top-0 z-40 border-b border-border bg-background/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-3 px-4 sm:px-6">
          <button
            aria-label="Open chapters"
            className="-ml-1 rounded-lg p-1.5 text-foreground/80 hover:bg-muted lg:hidden"
            onClick={() => setMenu(true)}
            type="button"
          >
            <Menu className="size-5" />
          </button>
          <Link className="flex shrink-0 items-center gap-2" href="/">
            <BrandMark adaptive className="h-6" />
            <span className="font-heading text-[15px] font-semibold text-foreground">
              {PLATFORM_NAME} <span className="hidden sm:inline">Guide</span>
            </span>
          </Link>
          <span className="hidden rounded-lg border border-border px-2 py-0.5 font-mono text-xs text-muted-foreground sm:block">
            v{version}
          </span>

          <div className="flex flex-1 justify-center px-2">
            <GuideSearch
              trigger={(open) => (
                <button
                  className="flex h-10 w-full max-w-sm items-center gap-2.5 rounded-full border border-border bg-background px-4 text-sm text-muted-foreground shadow-sm transition-colors duration-150 hover:border-primary/40"
                  onClick={open}
                  type="button"
                >
                  <Search aria-hidden className="size-4" />
                  <span className="flex-1 text-left">Search anything…</span>
                  <kbd className="hidden rounded-md border border-border px-1.5 py-0.5 font-sans text-[11px] sm:block">
                    Ctrl K
                  </kbd>
                </button>
              )}
            />
          </div>

          <nav aria-label="Site" className="hidden items-center gap-1 lg:flex">
            {NAV.map((n) => {
              const active = n.href === "/guide" ? path.startsWith("/guide") : false;
              return (
                <Link
                  className={cn(
                    "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
                    active ? "bg-primary/10 text-primary" : "text-foreground/75 hover:text-foreground",
                  )}
                  href={n.href}
                  key={n.href}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <GuideLangSwitch />
          <ThemeToggle />
        </div>
      </header>

      <div className="mx-auto flex max-w-[1440px]">
        <aside className="hidden w-[304px] shrink-0 border-r border-border lg:block">
          <div className="thin-scrollbar sticky top-16 max-h-[calc(100dvh-4rem)] overflow-y-auto px-4 py-7">
            <Sidebar />
          </div>
        </aside>
        {/* Chapter URLs share one reader (it rewrites the URL as you scroll), so
            they must not remount it; other pages fade in fresh. */}
        <main className="min-w-0 flex-1 animate-page-in" key={/^\/guide\/[^/]+\/[^/]+$/.test(path) ? "reader" : path}>
          {children}
        </main>
      </div>

      <Sheet onOpenChange={setMenu} open={menu}>
        <SheetContent className="w-[300px] overflow-y-auto" side="left">
          <SheetHeader>
            <SheetTitle>Guide</SheetTitle>
          </SheetHeader>
          <div className="px-1 pb-8">
            <Sidebar onPick={() => setMenu(false)} />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
