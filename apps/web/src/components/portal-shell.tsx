"use client";

import {
  Activity,
  BedDouble,
  Bell,
  Building2,
  CalendarDays,
  Camera,
  ChartNoAxesColumn,
  ChevronDown,
  ClipboardList,
  CreditCard,
  Flag,
  FileText,
  Gift,
  Globe,
  HelpCircle,
  LayoutDashboard,
  LayoutTemplate,
  MapPin,
  Megaphone,
  Menu,
  MessageSquare,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  QrCode,
  ReceiptText,
  ScrollText,
  Settings,
  ShieldCheck,
  Siren,
  Sparkles,
  Star,
  Tag,
  ToggleLeft,
  UserRound,
  Users,
  Utensils,
  Wrench,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";

import { HostelPreviewLink } from "@/components/hostel-preview-link";
import {
  HostelSuspendedScreen,
  HostelSuspensionNotice,
  useHostelSuspension,
} from "@/components/hostel-suspension-gate";
import { BrandMark } from "@/components/brand-mark";
import { GetAppDialog } from "@/components/get-app-dialog";
import { NotificationBell } from "@/components/notification-bell";
import { PortalAccount } from "@/components/portal-account";
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

const iconMap: Record<PortalIconName, LucideIcon> = {
  activity: Activity,
  bed: BedDouble,
  bell: Bell,
  building: Building2,
  calendar: CalendarDays,
  camera: Camera,
  card: CreditCard,
  chart: ChartNoAxesColumn,
  clipboard: ClipboardList,
  dashboard: LayoutDashboard,
  file: FileText,
  flag: Flag,
  food: Utensils,
  gift: Gift,
  globe: Globe,
  help: HelpCircle,
  layout: LayoutTemplate,
  map: MapPin,
  megaphone: Megaphone,
  message: MessageSquare,
  moon: Moon,
  qr: QrCode,
  receipt: ReceiptText,
  scroll: ScrollText,
  settings: Settings,
  shield: ShieldCheck,
  siren: Siren,
  sparkles: Sparkles,
  star: Star,
  tag: Tag,
  toggle: ToggleLeft,
  user: UserRound,
  users: Users,
  wrench: Wrench,
};

/**
 * Where each portal's bell points. Platform admins deliberately have no
 * notifications surface of their own (see MEMORY.md), so they land on the
 * audit log, which is the equivalent feed for that role.
 */
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

const TEAM_TONE = {
  active: "bg-brand-teal text-white shadow-sm",
  badge: "border-role-team/25 bg-role-team-soft text-role-team",
  brand: "text-role-team",
  brandSoft: "bg-brand-teal",
  hover: "hover:bg-role-team-soft/70 hover:text-role-team",
  ring: "ring-role-team/20",
  softBg: "bg-role-team-soft",
  text: "text-role-team",
};

const toneStyles: Record<
  PortalTone,
  {
    active: string;
    badge: string;
    brand: string;
    brandSoft: string;
    hover: string;
    /** Idle row text; defaults to the slate every other portal uses. */
    navText?: string;
    ring: string;
    softBg: string;
    text: string;
  }
> = {
  admin: {
    active: "bg-role-admin text-white shadow-sm",
    badge: "border-role-admin/20 bg-role-admin-soft text-role-admin",
    brand: "text-role-admin",
    brandSoft: "bg-role-admin",
    hover: "hover:bg-role-admin-soft/70 hover:text-role-admin",
    ring: "ring-role-admin/20",
    softBg: "bg-role-admin-soft",
    text: "text-role-admin",
  },
  guardian: {
    active: "bg-role-guardian text-white shadow-sm",
    badge: "border-role-guardian/20 bg-role-guardian-soft text-role-guardian",
    brand: "text-role-guardian",
    brandSoft: "bg-role-guardian",
    hover: "hover:bg-role-guardian-soft/70 hover:text-role-guardian",
    ring: "ring-role-guardian/20",
    softBg: "bg-role-guardian-soft",
    text: "text-role-guardian",
  },
  /*
   * The owner's sidebar is plain dark text: no teal on hover, active or open
   * parents — a grey wash and weight mark where you are. `navText` replaces the
   * slate the other portals use for idle rows.
   */
  platform: {
    active: "bg-muted font-semibold text-foreground",
    badge: "border-role-platform/20 bg-role-platform-soft text-role-platform",
    brand: "text-brand-teal",
    brandSoft: "bg-brand-teal",
    hover: "hover:bg-muted hover:text-foreground",
    navText: "text-foreground",
    ring: "ring-role-platform/20",
    softBg: "bg-muted",
    text: "text-foreground",
  },
  resident: {
    active: "bg-role-resident text-white shadow-sm",
    badge: "border-role-resident/20 bg-role-resident-soft text-role-resident",
    brand: "text-role-resident",
    brandSoft: "bg-role-resident",
    hover: "hover:bg-role-resident-soft/70 hover:text-role-resident",
    ring: "ring-role-resident/20",
    softBg: "bg-role-resident-soft",
    text: "text-role-resident",
  },
  /*
   * The field desk wears the product's own green.
   *
   * It used to borrow the platform teal on the grounds that an agent works for
   * the platform. That reasoning holds for who they are and not for who is
   * looking: the desk is the one portal an owner is walked through in person,
   * on the agent's phone, minutes before they see the green brand everywhere
   * else — so the sidebar matching the product is worth more here than the
   * internal hierarchy the teal was expressing.
   *
   * The active pill paints `--brand-teal` (#0a8a4b in both themes, 4.9:1 under
   * white) rather than `--role-team`, which goes bright in dark mode because it
   * only ever carries text and icons. Painting the pill with the bright value
   * would have put white on #34d399 at 1.8:1.
   */
  team: TEAM_TONE,
  // The cook and provider apps wear the product green too.
  cook: TEAM_TONE,
  provider: TEAM_TONE,
};

type PlanState = {
  outstanding: number;
  subscription: {
    currentPeriodEnd: string | null;
    dueBy: string | null;
    planName: string | null;
    status: string;
  };
} | null;

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

/** One line under the plan name: the fact the owner needs, nothing more. */
function planLine(state: NonNullable<PlanState>) {
  const { currentPeriodEnd, dueBy, status } = state.subscription;

  if (state.outstanding > 0) {
    return `Rs ${state.outstanding.toLocaleString("en-IN")} due${dueBy ? ` by ${shortDate(dueBy)}` : ""}`;
  }

  if (status === "ACTIVE") {
    return currentPeriodEnd ? `Active till ${shortDate(currentPeriodEnd)}` : "Active";
  }

  return status === "PENDING_SELECTION" ? "Choose a plan" : "Not active yet";
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
  const styles = toneStyles[tone];
  // Only the hostel workspace buys a plan; the card reads the real subscription.
  const planResource = usePortalResource<{ state: PlanState }>(
    tone === "admin" ? "/api/v1/hostel-admin/subscription" : null,
  );
  const plan = planResource.data?.state ?? null;
  // The hostel's plan suspension, for the hostel's own portals only.
  const suspension = useHostelSuspension(tone);
  const suspended = suspension?.stage === "SUSPENDED";
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [navPathname, setNavPathname] = useState(pathname);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isDesktop = useSyncExternalStore(
    subscribeToDesktopBreakpoint,
    getIsDesktopSnapshot,
    getIsDesktopServerSnapshot,
  );

  // Close the mobile nav on navigation (state reset during render, per
  // react.dev "adjusting state when props change" — avoids an effect).
  if (navPathname !== pathname) {
    setNavPathname(pathname);
    setMobileNavOpen(false);
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

  function isActiveHref(href: string) {
    return href === activeHref;
  }

  function hasActiveChild(item: PortalNavItem) {
    return (item.children ?? []).some((child) => isActiveHref(child.href));
  }

  const roleLabel = subtitle;
  const sidebarSubtitle = workspaceName ?? subtitle;

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
    const Icon = iconMap[item.icon ?? "dashboard"];
    // In the collapsed rail the children are not rendered, so the parent has to
    // carry their highlight or nothing in the sidebar looks active at all.
    const isActive = isActiveHref(item.href) || hasActiveChild(item);

    return (
      <Link
        className={cn(
          "flex min-h-0 items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[12.5px] font-medium transition-colors",
          styles.navText ?? "text-slate-600 dark:text-slate-300",
          styles.hover,
          isActive && styles.active,
          collapsed && "justify-center px-0",
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
          <Icon className="size-[15px] shrink-0" strokeWidth={isActive ? 2.3 : 1.9} />
        )}
        {collapsed ? null : (
          <>
            <span className="truncate">{item.label}</span>
            {item.badge && item.badge > 0 ? (
              <Badge
                className={cn(
                  "ml-auto h-[18px] min-w-[18px] rounded-full px-1.5 text-[10px] font-bold",
                  isActive
                    ? styles.navText
                      ? "border-transparent bg-foreground text-background"
                      : "border-white/20 bg-white/20 text-white"
                    : "border-transparent bg-role-resident text-white",
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

    const Icon = iconMap[item.icon ?? "dashboard"];
    const childActive = hasActiveChild(item);
    const isOpen = expanded[item.label] ?? childActive;

    return (
      <div key={item.label}>
        <button
          className={cn(
            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-[7px] text-[12.5px] font-medium transition-colors",
            styles.navText ?? "text-slate-600 dark:text-slate-300",
            styles.hover,
            childActive && cn(styles.softBg, styles.text, "font-semibold"),
          )}
          onClick={() =>
            setExpanded((current) => ({ ...current, [item.label]: !isOpen }))
          }
          type="button"
        >
          <Icon className="size-[15px] shrink-0" strokeWidth={childActive ? 2.3 : 1.9} />
          <span className="truncate">{item.label}</span>
          <ChevronDown
            className={cn(
              "ml-auto size-3.5 shrink-0 transition-transform",
              isOpen && "rotate-180",
            )}
          />
        </button>

        {isOpen ? (
          <div className="relative mt-0.5 space-y-0.5">
            <span className="absolute bottom-1 left-[18px] top-1 w-px bg-border" />
            {children.map((child) =>
              renderLeaf({ child: true, item: child, onNavigate }),
            )}
          </div>
        ) : null}
      </div>
    );
  }

  function renderNav(onNavigate?: () => void, collapsed = false) {
    return (
      <nav className="flex flex-col gap-2.5 px-2 py-2.5">
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
            <div className="space-y-0.5">
              {group.items.map((item) => renderItem(item, collapsed, onNavigate))}
            </div>
          </div>
        ))}
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
      <div className="border-t border-slate-100 p-2 dark:border-border">
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
            <span className={cn("block truncate text-[12px] font-bold", styles.text)}>
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
            <p
              className={cn(
                "font-heading text-[15px] font-bold tracking-tight",
                styles.brand,
              )}
            >
              {portalName}
            </p>
            <p className="truncate text-[10.5px] font-medium text-slate-500 dark:text-muted-foreground">
              {sidebarSubtitle}
            </p>
          </div>
        )}
      </Link>
    );
  }

  return (
    /* One socket per portal tab, opened here rather than in the root layout so
       the public pages never attempt an authenticated subscription. Everything
       inside — the bell and every panel's cached queries — updates from it. */
    <RealtimeProvider>
    {/* Viewport-height frame: the brand rail, top bar, and copyright bar stay
        put while only the nav list and the content pane scroll. */}
    <div
      className="relative flex h-dvh flex-col overflow-hidden bg-[#f4f7fb] text-foreground dark:bg-background"
      inert={suspended}
    >
      <div className="flex min-h-0 flex-1">
        <aside
          className={cn(
            "hidden shrink-0 flex-col border-r border-slate-200/80 bg-white transition-[width] duration-200 md:flex dark:border-border dark:bg-card",
            sidebarCollapsed ? "w-[68px]" : "w-[236px]",
          )}
        >
          <div className="shrink-0 border-b border-slate-100 px-3 py-2.5 dark:border-border">
            {renderBrand(sidebarCollapsed)}
          </div>

          <div className="no-scrollbar min-h-0 flex-1 overflow-y-auto">
            {renderNav(undefined, sidebarCollapsed)}
          </div>

          <div className="shrink-0">{renderSidebarFooter(sidebarCollapsed)}</div>
        </aside>

        <Sheet onOpenChange={setMobileNavOpen} open={mobileNavOpen}>
          <SheetContent
            className="flex w-[264px] flex-col gap-0 p-0 sm:max-w-[264px]"
            side="left"
          >
            <SheetHeader className="shrink-0 border-b border-slate-100 px-3 py-3 dark:border-border">
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
          <header className="relative z-30 shrink-0 border-b border-slate-200/80 bg-white/95 backdrop-blur dark:border-border dark:bg-card/95">
            <div className="flex h-14 items-center gap-2.5 px-3 md:px-5">
              <Button
                aria-label={
                  isDesktop
                    ? sidebarCollapsed
                      ? "Expand navigation"
                      : "Collapse navigation"
                    : "Open navigation"
                }
                className="size-8 rounded-lg border-slate-200 bg-white text-slate-600 shadow-sm md:inline-flex"
                onClick={handleNavToggle}
                size="icon"
                type="button"
                variant="outline"
              >
                {isDesktop ? (
                  sidebarCollapsed ? (
                    <PanelLeftOpen className="size-4" />
                  ) : (
                    <PanelLeftClose className="size-4" />
                  )
                ) : (
                  <Menu className="size-4" />
                )}
              </Button>

              <div className="hidden min-w-0 md:block">{workspaceSwitcher}</div>

              <PortalSearch
                className="hidden max-w-xl md:block"
                entries={searchEntries}
                placeholder={searchPlaceholder}
                tone={tone}
              />

              <div className="ml-auto flex items-center gap-1.5 md:gap-2">
                {/* The community is one platform-wide room at `/community`, not
                    a per-portal feed — so it lives in every header instead of
                    four sidebars. The field desk is the exception: an agent is
                    registering somebody else's hostel, often with that owner
                    watching the screen, and a room full of residents and
                    wardens is not a door to leave open in the middle of it. */}
                {tone === "team" ? null : (
                  <Link
                    className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium text-slate-600 transition-colors hover:bg-muted hover:text-foreground dark:text-slate-300"
                    href="/community"
                  >
                    <Users className="size-4" />
                    <span className="hidden sm:inline">Community</span>
                  </Link>
                )}

                {tone === "admin" ? (
                  <HostelPreviewLink className="hidden lg:inline-flex" />
                ) : null}

                {tone === "team" || tone === "platform" ? null : (
                  <GetAppDialog className="px-2.5 py-1.5 text-[12.5px]" comingSoon />
                )}

                <ThemeToggle className="hidden size-8 sm:inline-flex" />

                <NotificationBell href={NOTIFICATIONS_HREF[tone] ?? "/notifications"} />

                <Badge
                  className={cn(
                    "hidden h-auto items-center rounded-full border px-2.5 py-1 text-[11px] font-semibold sm:inline-flex",
                    styles.badge,
                  )}
                  variant="outline"
                >
                  {roleLabel}
                </Badge>

                <PortalAccount tone={tone} />
              </div>
            </div>

            <div className="border-t border-slate-100 px-3 py-2 md:hidden dark:border-border">
              {workspaceSwitcher ? <div className="mb-2">{workspaceSwitcher}</div> : null}
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
          <main className="no-scrollbar relative min-h-0 flex-1 overflow-y-auto px-3.5 py-4 md:px-5 md:py-4">
            {suspension && !suspended && tone === "admin" ? (
              <HostelSuspensionNotice suspension={suspension} />
            ) : null}
            {children}
          </main>
        </div>
      </div>

      <footer className="shrink-0 border-t border-slate-200/80 bg-white px-4 py-2 text-[11px] text-slate-500 dark:border-border dark:bg-card dark:text-muted-foreground md:px-5">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <p>© 2026 {portalName} Platform. All rights reserved.</p>
          <div className="flex items-center gap-4">
            {/* Support moved out of the sidebar card — same entry point, but it
                sits beside the credit instead of eating nav space. */}
            {tone !== "platform" && (
              <a
                className="inline-flex items-center gap-1 font-medium text-slate-600 hover:text-foreground dark:text-muted-foreground"
                href={identity.supportEmail ? `mailto:${identity.supportEmail}` : "/contact"}
              >
                <HelpCircle className="size-3" />
                Help &amp; Support
              </a>
            )}
            <p>
              Made with <span className="text-rose-500">♥</span> in Nepal 🇳🇵
            </p>
          </div>
        </div>
      </footer>
    </div>
    {suspension && suspended ? (
      <HostelSuspendedScreen suspension={suspension} tone={tone} />
    ) : null}
    </RealtimeProvider>
  );
}

export type { PortalTone };
