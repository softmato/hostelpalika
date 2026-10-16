"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import {
  HostelSuspendedScreen,
  HostelSuspensionNotice,
  useHostelSuspension,
} from "@/components/hostel-suspension-gate";
import { BrandMark } from "@/components/brand-mark";
import { GetAppDialog } from "@/components/get-app-dialog";
import { Glyph, type GlyphName } from "@/components/glyph";
import {
  isKycFrozenPortalPath,
  KycFrozenPage,
  TrialEndedOverlay,
  TrialWelcomeDialog,
  useKycPortalLock,
  useTrialEndedBlock,
} from "@/components/kyc-gate";
import { NotificationBell } from "@/components/notification-bell";
import { PortalAccount } from "@/components/portal-account";
import { PortalPageIconProvider } from "@/components/portal-page-context";
import { PortalSearch, revealField } from "@/components/portal-search";
import { RealtimeProvider } from "@/components/realtime-provider";
import { ThemeToggle } from "@/components/theme-toggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import type {
  PortalIconName,
  PortalNavGroup,
  PortalNavItem,
  PortalNavLeaf,
  PortalSearchEntry,
} from "@/lib/portal-nav";
import { usePortalResource, usePrefetchPortalHref } from "@/lib/portal-query";
import { useSiteConfig } from "@/components/site-config-provider";
import { cn } from "@/lib/utils";

type PortalTone = "platform" | "admin" | "resident" | "guardian" | "team" | "cook" | "provider";

type PortalShellProps = {
  children: ReactNode;
  navGroups: PortalNavGroup[];
  /** Defaults to the platform-owner-configured site name. */
  portalName?: string;
  searchEntries?: PortalSearchEntry[];
  searchPlaceholder?: string;
  subtitle: string;
  tone?: PortalTone;
  workspaceName?: string;
  /** The hostel switcher, for an owner with branches. Rendered in the header. */
  workspaceSwitcher?: ReactNode;
};

/** The nav's icon vocabulary, drawn with our own glyphs (`glyphs.ts`). */
const iconMap: Record<PortalIconName, GlyphName> = {
  activity: "pulse",
  bed: "bed",
  bell: "notifications",
  building: "business",
  calendar: "calendar",
  camera: "camera",
  card: "card",
  chart: "stats-chart",
  clipboard: "clipboard",
  dashboard: "grid",
  file: "document-text",
  flag: "flag",
  food: "restaurant",
  gift: "gift",
  globe: "globe",
  help: "help-circle",
  layout: "dashboard",
  map: "location",
  megaphone: "megaphone",
  message: "chatbox",
  moon: "moon",
  qr: "qr-code",
  receipt: "receipt",
  scroll: "reader",
  settings: "settings",
  shield: "shield-checkmark",
  siren: "siren",
  sparkles: "sparkles",
  star: "star",
  tag: "pricetag",
  toggle: "toggle",
  user: "person",
  users: "people",
  wrench: "build",
};

/**
 * Where each portal's bell sends "View all".
 *
 * Admin and platform point at an *inbox* rather than at
 * `/hostel-admin/notifications` (the outbound campaign composer) or
 * `/platform/audit-logs` (a record of what everyone did) — neither of which is
 * the reader's own feed.
 */
const NOTIFICATIONS_HREF: Record<PortalTone, string> = {
  admin: "/hostel-admin/inbox",
  cook: "/cook/notifications",
  guardian: "/guardian/notifications",
  platform: "/platform/inbox",
  provider: "/jobs/notifications",
  resident: "/resident/notifications",
  // An agent reads the platform's inbox; the desk has no feed of its own.
  team: "/platform/inbox",
};

/*
 * Every portal wears the same green, black and white (2026-10-16), so there is
 * one row style rather than a table per tone. `role-team` is the green that
 * carries text: #0a8a4b in light, #12a95d in dark (`globals.css`).
 */
const ROW_IDLE = "text-slate-600 hover:bg-muted hover:text-foreground dark:text-slate-300";
const ROW_ACTIVE =
  "bg-role-team-soft font-semibold text-foreground before:absolute before:inset-y-1.5 before:-left-2 before:w-[3px] before:rounded-full before:bg-role-team";

/**
 * Past this many destinations the sidebar splits into two tiers: a rail of
 * sections and a panel with the chosen section's pages. Platform (35) and the
 * hostel admin (34) split; resident (17) and the small portals stay one list,
 * where a rail would only add a click.
 */
const TWO_TIER_AFTER = 20;

type PlanState = {
  outstanding: number;
  subscription: {
    currentPeriodEnd: string | null;
    dueBy: string | null;
    lifetimeSince?: string | null;
    planName: string | null;
    status: string;
  };
} | null;

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** One line under the plan name: the fact the owner needs, nothing more. */
function planLine(state: NonNullable<PlanState>) {
  const { currentPeriodEnd, dueBy, lifetimeSince, status } = state.subscription;

  if (state.outstanding > 0) {
    return `Rs ${state.outstanding.toLocaleString("en-IN")} due${dueBy ? ` by ${shortDate(dueBy)}` : ""}`;
  }

  if (status === "ACTIVE" && lifetimeSince) {
    return "Lifetime plan";
  }

  if (status === "ACTIVE") {
    return currentPeriodEnd ? `Active till ${shortDate(currentPeriodEnd)}` : "Active";
  }

  return status === "PENDING_SELECTION" ? "Choose a plan" : "Not active yet";
}

function groupIcon(group: PortalNavGroup): GlyphName {
  return iconMap[group.icon ?? group.items[0]?.icon ?? "dashboard"];
}

/** The unlabelled first block is the portal's home. */
function groupName(group: PortalNavGroup, index: number) {
  return group.short ?? group.label ?? (index === 0 ? "Home" : "More");
}

/**
 * Whether the viewport is at Tailwind's `md` breakpoint (768px) — the point
 * where the persistent sidebar takes over from the mobile drawer. Read via
 * `useSyncExternalStore` so the subscription lives outside React's render
 * cycle (no effect-driven setState) and SSR gets a stable false snapshot.
 */
function subscribeToDesktopBreakpoint(onChange: () => void) {
  const query = window.matchMedia("(min-width: 768px)");

  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function getIsDesktopSnapshot() {
  return window.matchMedia("(min-width: 768px)").matches;
}

function getIsDesktopServerSnapshot() {
  return false;
}

export function PortalShell({
  children,
  navGroups,
  portalName: portalNameProp,
  searchEntries = [],
  searchPlaceholder = "Search...",
  subtitle,
  tone = "platform",
  workspaceName,
  workspaceSwitcher,
}: PortalShellProps) {
  const pathname = usePathname();
  const prefetchHref = usePrefetchPortalHref();
  // A pasted `?field=` link; the palette handles the ones it opens itself.
  useEffect(() => revealField(window.location.href), []);
  const { identity } = useSiteConfig();
  // Admin-configured branding wins; the prop is only an explicit override.
  const portalName = portalNameProp ?? identity.siteName;
  const cleanHeader = tone === "admin" || tone === "resident";
  // Only the hostel workspace buys a plan; the card reads the real subscription.
  const planResource = usePortalResource<{ state: PlanState }>(
    tone === "admin" ? "/api/v1/hostel-admin/subscription" : null,
  );
  const plan = planResource.data?.state ?? null;
  // The hostel's plan suspension, for the hostel's own portals only.
  const suspension = useHostelSuspension(tone);
  const suspended = suspension?.stage === "SUSPENDED";
  // A quick sign-up's frozen pages, until its KYC is approved (`kyc-gate.tsx`).
  const { locked: kycLocked } = useKycPortalLock(tone);
  const trialEnded = useTrialEndedBlock(tone, pathname);
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [navPathname, setNavPathname] = useState(pathname);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // A rail section opened to look inside, before anything in it is chosen.
  const [peekGroup, setPeekGroup] = useState<number | null>(null);
  const isDesktop = useSyncExternalStore(
    subscribeToDesktopBreakpoint,
    getIsDesktopSnapshot,
    getIsDesktopServerSnapshot,
  );

  // Close the mobile nav and drop any peeked section on navigation (state reset
  // during render, per react.dev "adjusting state when props change" — avoids
  // an effect).
  if (navPathname !== pathname) {
    setNavPathname(pathname);
    setMobileNavOpen(false);
    setPeekGroup(null);
  }

  function handleNavToggle() {
    if (isDesktop) {
      setSidebarCollapsed((collapsed) => !collapsed);
    } else {
      setMobileNavOpen(true);
    }
  }

  /*
   * Exactly one destination is active, and it is the most specific one.
   *
   * A plain `startsWith` marked every ancestor active too, so on `/team/register`
   * both "My desk" (`/team`) and "Register a hostel" lit up and the sidebar
   * stopped saying where you were. Every portal whose index route is the prefix
   * of its siblings had the same bug; resolving the longest match once, here,
   * fixes all of them rather than special-casing index hrefs one nav at a time.
   */
  const activeHref = useMemo(() => {
    const hrefs = navGroups.flatMap((group) =>
      group.items.flatMap((item) => [item.href, ...(item.children ?? []).map((c) => c.href)]),
    );

    return hrefs.reduce<string | null>((best, href) => {
      const matches = pathname === href || pathname.startsWith(`${href}/`);

      return matches && (best === null || href.length > best.length) ? href : best;
    }, null);
  }, [navGroups, pathname]);

  const destinations = navGroups.reduce(
    (count, group) => count + group.items.reduce((n, item) => n + 1 + (item.children?.length ?? 0), 0),
    0,
  );
  const twoTier = destinations > TWO_TIER_AFTER;
  const activeGroupIndex = navGroups.findIndex((group) =>
    group.items.some(
      (item) => item.href === activeHref || (item.children ?? []).some((child) => child.href === activeHref),
    ),
  );
  const shownGroupIndex = peekGroup ?? Math.max(activeGroupIndex, 0);
  const shownGroup = navGroups[shownGroupIndex];

  // The page header wears its nav row's glyph (`PortalPageHeader`).
  const pageIcon = useMemo<GlyphName | null>(() => {
    for (const group of navGroups) {
      for (const item of group.items) {
        if (item.href === activeHref) return item.icon ? iconMap[item.icon] : null;
        const child = (item.children ?? []).find((leaf) => leaf.href === activeHref);
        if (child) return iconMap[child.icon ?? item.icon ?? "dashboard"];
      }
    }

    return null;
  }, [activeHref, navGroups]);

  function isActiveHref(href: string) {
    return href === activeHref;
  }

  function hasActiveChild(item: PortalNavItem) {
    return (item.children ?? []).some((child) => isActiveHref(child.href));
  }

  const sidebarSubtitle = workspaceName ?? subtitle;
  const supportHref = identity.supportEmail ? `mailto:${identity.supportEmail}` : "/contact";

  function renderLeaf({
    child = false,
    collapsed = false,
    item,
    onNavigate,
  }: {
    child?: boolean;
    collapsed?: boolean;
    item: PortalNavLeaf;
    onNavigate?: () => void;
  }) {
    // In the collapsed rail the children are not rendered, so the parent has to
    // carry their highlight or nothing in the sidebar looks active at all.
    const isActive = isActiveHref(item.href) || hasActiveChild(item);
    const frozen = kycLocked && isKycFrozenPortalPath(item.href);

    return (
      <Link
        aria-current={isActiveHref(item.href) ? "page" : undefined}
        className={cn(
          "relative flex min-h-0 items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[12.5px] font-medium transition-colors duration-150",
          frozen && "opacity-60",
          isActive ? ROW_ACTIVE : ROW_IDLE,
          collapsed && "justify-center px-0 before:hidden",
          child && !collapsed && "py-1.5 pl-8 text-[12px]",
        )}
        href={item.href}
        key={item.href}
        onClick={onNavigate}
        // Next prefetches the route payload on its own; this warms the data the
        // destination will ask for, so the page paints filled instead of empty.
        onFocus={() => prefetchHref(item.href)}
        onMouseEnter={() => prefetchHref(item.href)}
        title={collapsed ? item.label : undefined}
      >
        {child ? null : (
          <Glyph
            className={cn("size-[16px] shrink-0", isActive && "text-role-team")}
            name={iconMap[item.icon ?? "dashboard"]}
            variant={isActive ? "solid" : "line"}
          />
        )}
        {collapsed ? null : (
          <>
            <span className="truncate">{item.label}</span>
            {frozen ? <Glyph aria-label="Locked until KYC is approved" className="ml-auto size-3 shrink-0" name="lock-closed" /> : null}
            {item.badge && item.badge > 0 ? (
              <Badge
                className={cn(
                  "ml-auto h-[18px] min-w-[18px] rounded-full border-transparent px-1.5 text-[10px] font-bold",
                  isActive ? "bg-foreground text-background" : "bg-brand-teal text-white",
                )}
              >
                {item.badge}
              </Badge>
            ) : null}
          </>
        )}
      </Link>
    );
  }

  function renderItem(item: PortalNavItem, collapsed: boolean, onNavigate?: () => void) {
    const children = item.children ?? [];

    // In the collapsed rail there is no room for an accordion — the parent
    // becomes a plain link to its first destination.
    if (children.length === 0 || collapsed) {
      return renderLeaf({ collapsed, item, onNavigate });
    }

    const childActive = hasActiveChild(item);
    const isOpen = expanded[item.label] ?? childActive;

    return (
      <div key={item.label}>
        <button
          aria-expanded={isOpen}
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[12.5px] font-medium transition-colors duration-150",
            ROW_IDLE,
            childActive && "font-semibold text-foreground",
          )}
          onClick={() =>
            setExpanded((current) => ({ ...current, [item.label]: !isOpen }))
          }
          type="button"
        >
          <Glyph
            className={cn("size-[16px] shrink-0", childActive && "text-role-team")}
            name={iconMap[item.icon ?? "dashboard"]}
            variant={childActive ? "solid" : "line"}
          />
          <span className="truncate">{item.label}</span>
          <Glyph
            className={cn("ml-auto size-3.5 shrink-0 transition-transform duration-200", isOpen && "rotate-180")}
            name="chevron-down"
          />
        </button>

        {/* Grid-rows 0fr → 1fr: the accordion opens to its own height. */}
        <div
          className={cn(
            "grid transition-[grid-template-rows] duration-200 ease-out",
            isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
          )}
        >
          <div className="overflow-hidden" inert={!isOpen}>
            <div className="relative mt-0.5 space-y-0.5">
              <span className="absolute bottom-1 left-[18px] top-1 w-px bg-border" />
              {children.map((child) =>
                renderLeaf({ child: true, item: child, onNavigate }),
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  function renderGroupItems(group: PortalNavGroup, collapsed = false, onNavigate?: () => void) {
    return (
      <div className="space-y-0.5">
        {group.items.map((item) => renderItem(item, collapsed, onNavigate))}
      </div>
    );
  }

  function renderNav(onNavigate?: () => void, collapsed = false) {
    return (
      <nav className="flex flex-col gap-3 px-2 py-2.5">
        {navGroups.map((group, groupIndex) => (
          <div key={group.label ?? `group-${groupIndex}`}>
            {group.label && !collapsed ? (
              <p className="px-2.5 pb-1.5 text-[10px] font-bold uppercase tracking-[0.14em] text-slate-400 dark:text-muted-foreground">
                {group.label}
              </p>
            ) : null}
            {group.label && collapsed && groupIndex > 0 ? (
              <div className="mx-auto mb-2 h-px w-7 bg-border" />
            ) : null}
            {renderGroupItems(group, collapsed, onNavigate)}
          </div>
        ))}
      </nav>
    );
  }

  /**
   * The first tier: one tile per section. A section with a single page is a
   * link; any other opens its pages in the panel without navigating, so the
   * rail can be browsed.
   */
  function renderRail() {
    return (
      <nav aria-label="Sections" className="flex flex-col items-center gap-1 px-2 py-2">
        {navGroups.map((group, index) => {
          const active = index === activeGroupIndex;
          const shown = index === shownGroupIndex && !sidebarCollapsed;
          const only = group.items.length === 1 && !(group.items[0].children?.length ?? 0) ? group.items[0] : null;
          const className = cn(
            "group/rail flex w-full flex-col items-center gap-1 rounded-xl py-1.5 text-[10px] font-medium transition-colors duration-150",
            active ? "text-role-team" : "text-slate-500 hover:text-foreground dark:text-slate-400",
          );
          const body = (
            <>
              <span
                className={cn(
                  "flex size-9 items-center justify-center rounded-xl transition-all duration-200",
                  active ? "bg-role-team-soft" : shown ? "bg-muted text-foreground" : "group-hover/rail:bg-muted",
                  "group-active/rail:scale-95",
                )}
              >
                <Glyph className="size-[18px]" name={groupIcon(group)} variant={active ? "solid" : "line"} />
              </span>
              <span className="max-w-full truncate px-0.5">{groupName(group, index)}</span>
            </>
          );

          return only ? (
            <Link
              aria-current={active ? "page" : undefined}
              className={className}
              href={only.href}
              key={only.href}
              onFocus={() => prefetchHref(only.href)}
              onMouseEnter={() => prefetchHref(only.href)}
              title={only.label}
            >
              {body}
            </Link>
          ) : (
            <button
              aria-expanded={shown}
              className={className}
              key={group.label ?? `group-${index}`}
              onClick={() => {
                setPeekGroup(index);
                setSidebarCollapsed(false);
              }}
              title={group.label}
              type="button"
            >
              {body}
            </button>
          );
        })}
      </nav>
    );
  }

  function renderSidebarFooter(collapsed = false) {
    // Only the hostel workspace buys a plan. The platform owner runs the
    // product, and a resident pays their hostel rent — not us — so a
    // subscription card in either sidebar is noise.
    if (collapsed || !plan) {
      return null;
    }

    const owing = plan.outstanding > 0;

    return (
      <div className="border-t border-border/70 p-2">
        <Link
          className="flex items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-muted"
          href="/hostel-admin/billing"
        >
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full",
              owing ? "bg-warning" : plan.subscription.status === "ACTIVE" ? "bg-success" : "bg-muted-foreground",
            )}
          />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-[12px] font-bold text-foreground">
              {plan.subscription.planName ?? "No plan"}
            </span>
            <span className={cn("block truncate text-[10px]", owing ? "text-warning" : "text-muted-foreground")}>
              {planLine(plan)}
            </span>
          </span>
        </Link>
      </div>
    );
  }

  function renderBrand(collapsed = false) {
    return (
      <Link
        className={cn("flex items-center gap-2.5", collapsed && "justify-center")}
        href="/"
        title={collapsed ? portalName : undefined}
      >
        <BrandMark adaptive className="h-7" />
        {collapsed ? null : (
          <div className="min-w-0 leading-tight">
            <p className="font-heading text-[15px] font-bold tracking-tight text-foreground">
              {portalName}
            </p>
            <p className="truncate text-[10.5px] font-medium text-muted-foreground">
              {sidebarSubtitle}
            </p>
          </div>
        )}
      </Link>
    );
  }

  const headerHeight = cleanHeader ? "h-16" : "h-14";

  return (
    /* One socket per portal tab, opened here rather than in the root layout so
       the public pages never attempt an authenticated subscription. Everything
       inside — the bell and every panel's cached queries — updates from it. */
    <RealtimeProvider>
    {/* Viewport-height frame: the sidebar and top bar stay put while only the
        nav list and the content pane scroll. */}
    <div
      className="relative flex h-dvh overflow-hidden bg-muted/60 text-foreground dark:bg-background"
      inert={suspended}
    >
      {twoTier ? (
        <>
          <aside className="z-20 hidden w-[76px] shrink-0 flex-col items-center border-r border-border/70 bg-background md:flex dark:bg-card">
            <Link className={cn("flex shrink-0 items-center justify-center", headerHeight)} href="/" title={portalName}>
              <BrandMark adaptive className="h-7" />
            </Link>
            <div className="no-scrollbar min-h-0 w-full flex-1 overflow-y-auto">{renderRail()}</div>
            {tone === "platform" ? null : (
              <a
                className="mb-3 flex size-9 items-center justify-center rounded-xl text-slate-500 transition-colors hover:bg-muted hover:text-foreground dark:text-slate-400"
                href={supportHref}
                title="Help & support"
              >
                <Glyph className="size-[18px]" name="help-circle" />
              </a>
            )}
          </aside>

          {/* The second tier slides shut instead of shrinking to icons: the
              rail already is the icon view. */}
          <aside
            className={cn(
              "hidden shrink-0 overflow-hidden border-r border-border/70 bg-background transition-[width] duration-300 ease-out md:block dark:bg-card",
              sidebarCollapsed ? "w-0 border-r-0" : "w-[220px]",
            )}
          >
            <div className="flex h-full w-[220px] flex-col">
              <div className={cn("flex shrink-0 flex-col justify-center border-b border-border/70 px-4", headerHeight)}>
                <p className="truncate font-heading text-[15px] font-bold tracking-tight">
                  {shownGroup?.label ?? portalName}
                </p>
                <p className="truncate text-[10.5px] font-medium text-muted-foreground">{sidebarSubtitle}</p>
              </div>
              <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
                {/* Keyed by section, so switching sections fades the list in. */}
                <nav className="animate-page-in px-2 py-2.5" key={shownGroupIndex}>
                  {shownGroup ? renderGroupItems(shownGroup) : null}
                </nav>
              </div>
              <div className="shrink-0">{renderSidebarFooter()}</div>
            </div>
          </aside>
        </>
      ) : (
        <aside
          className={cn(
            "hidden shrink-0 flex-col border-r border-border/70 bg-background transition-[width] duration-300 ease-out md:flex dark:bg-card",
            sidebarCollapsed ? "w-[68px]" : "w-[236px]",
          )}
        >
          <div className={cn("flex shrink-0 items-center border-b border-border/70 px-3", headerHeight)}>
            {renderBrand(sidebarCollapsed)}
          </div>

          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
            {renderNav(undefined, sidebarCollapsed)}
          </div>

          <div className="shrink-0">
            {tone === "platform" ? null : (
              <a
                className={cn(
                  "mx-2 mb-1 flex items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[12.5px] font-medium",
                  ROW_IDLE,
                  sidebarCollapsed && "justify-center px-0",
                )}
                href={supportHref}
                title="Help & support"
              >
                <Glyph className="size-[16px] shrink-0" name="help-circle" />
                {sidebarCollapsed ? null : <span>Help</span>}
              </a>
            )}
            {renderSidebarFooter(sidebarCollapsed)}
          </div>
        </aside>
      )}

      <Sheet onOpenChange={setMobileNavOpen} open={mobileNavOpen}>
        <SheetContent
          className="flex w-[264px] flex-col gap-0 p-0 sm:max-w-[264px]"
          side="left"
        >
          <SheetHeader className="shrink-0 border-b border-border/70 px-3 py-3">
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            {renderBrand()}
          </SheetHeader>
          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
            {renderNav(() => setMobileNavOpen(false))}
          </div>
          <div className="shrink-0">{renderSidebarFooter()}</div>
        </SheetContent>
      </Sheet>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="relative z-30 shrink-0 border-b border-border/70 bg-background/90 backdrop-blur dark:bg-card/90">
          <div className={cn("flex items-center px-3 md:px-5", headerHeight, cleanHeader ? "gap-3 md:gap-4" : "gap-2.5")}>
            <Button
              aria-label={
                isDesktop
                  ? sidebarCollapsed
                    ? "Expand navigation"
                    : "Collapse navigation"
                  : "Open navigation"
              }
              className="size-8 rounded-lg text-slate-600 dark:text-slate-300"
              onClick={handleNavToggle}
              size="icon"
              type="button"
              variant="ghost"
            >
              <Glyph
                className="size-[18px]"
                name={isDesktop ? (sidebarCollapsed ? "panel-open" : "panel-close") : "menu"}
              />
            </Button>

            <PortalSearch
              className="hidden max-w-xl md:block"
              entries={searchEntries}
              placeholder={searchPlaceholder}
              tone={tone}
            />

            <div className="ml-auto flex items-center gap-1.5 md:gap-2">
              {workspaceSwitcher ? (
                <div className="min-w-0 max-w-[45vw] md:max-w-none">{workspaceSwitcher}</div>
              ) : null}
              {/* The community is one platform-wide room at `/community`, not
                  a per-portal feed — so it lives in every header instead of
                  four sidebars. The field desk is the exception: an agent is
                  registering somebody else's hostel, often with that owner
                  watching the screen, and a room full of residents and
                  wardens is not a door to leave open in the middle of it. */}
              {tone === "team" || cleanHeader ? null : (
                <Link
                  aria-label="Community"
                  className="inline-flex size-8 items-center justify-center rounded-lg text-slate-600 transition-colors hover:bg-muted hover:text-foreground dark:text-slate-300"
                  href="/community"
                  title="Community"
                >
                  <Glyph className="size-[18px]" name="chatbubbles" />
                </Link>
              )}

              {tone === "team" || tone === "platform" || cleanHeader ? null : (
                <GetAppDialog className="px-2.5 py-1.5 text-[12.5px]" />
              )}

              {cleanHeader ? null : <ThemeToggle className="hidden size-8 sm:inline-flex" />}

              <div className={cn("flex shrink-0 items-center", cleanHeader && "mx-1 border-x border-border px-2 md:px-3")}>
                <NotificationBell href={NOTIFICATIONS_HREF[tone] ?? "/notifications"} />
              </div>

              <PortalAccount tone={tone} showPortalActions={cleanHeader} />
            </div>
          </div>

          <div className="border-t border-border/70 px-3 py-2 md:hidden">
            <PortalSearch
              entries={searchEntries}
              placeholder={searchPlaceholder}
              tone={tone}
            />
          </div>
        </header>

        {/* `relative` makes this the containing block for absolute children
            (every `sr-only` file input). Without it they are placed against
            the page instead, and a long form stretches the document with
            blank space below the shell. */}
        <main className="no-scrollbar relative min-h-0 flex-1 overflow-y-auto px-3.5 py-4 md:px-6 md:py-5">
          {suspension && !suspended && tone === "admin" ? (
            <HostelSuspensionNotice suspension={suspension} />
          ) : null}
          <PortalPageIconProvider value={pageIcon}>
            {/* Keyed by path, so every navigation fades the new page in. */}
            <div className="animate-page-in" key={pathname}>
              {kycLocked && isKycFrozenPortalPath(pathname) ? <KycFrozenPage /> : children}
            </div>
          </PortalPageIconProvider>
          <TrialWelcomeDialog tone={tone} />
        </main>
      </div>
    </div>
    {suspension && suspended ? (
      <HostelSuspendedScreen suspension={suspension} tone={tone} />
    ) : null}
    {trialEnded ? <TrialEndedOverlay status={trialEnded.status} /> : null}
    </RealtimeProvider>
  );
}

export type { PortalTone };
