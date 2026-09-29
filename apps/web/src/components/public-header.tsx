"use client";

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";
import {
  BadgePlus,
  CalendarCheck,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Menu,
  QrCode,
  Smartphone,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { checkAuthWithRefresh } from "@/lib/auth-check";
import { landingPathForRole } from "@/lib/route-access";
import { Role } from "@/lib/roles";
import { cn } from "@/lib/utils";
import { BrandWordmark } from "@/components/brand-mark";
import { GetAppDialog } from "@/components/get-app-dialog";
import {
  ResidentIdentityCenter,
  requestResidentProfileForm,
  requestResidentQr,
} from "@/components/resident-identity";
import { ThemeToggle } from "@/components/theme-toggle";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PublicPushOptIn } from "@/components/public-push-optin";
import { useSessionStore, type SessionUser } from "@/stores/session-store";
import { signOutRequest } from "@/lib/sign-out";

type PublicHeaderProps = {
  active?:
    | "about"
    | "blog"
    | "browse"
    | "community"
    | "compare"
    | "contact"
    | "home"
    | "how-booking-works"
    | "jobs"
    | "map"
    | "offer-program"
    | "plans-pricing"
    | "privacy"
    | "providers"
    | "refund-policy"
    | "register-hostel"
    | "terms";
};

type CurrentUser = SessionUser;

type MeResponse =
  | {
      data: {
        user: CurrentUser;
      };
      success: true;
    }
  | {
      message: string;
      success: false;
    };

const DASHBOARD_ROLES = new Set([
  Role.SUPERADMIN,
  Role.PLATFORM_MODERATOR,
  // The field team — their desk at `/team`.
  Role.PLATFORM_AGENT,
  Role.HOSTEL_ADMIN,
  Role.WARDEN,
  Role.RESIDENT,
  Role.GUARDIAN,
]);

function hasDashboard(role: Role) {
  return DASHBOARD_ROLES.has(role);
}

function dashboardHrefForRole(role: Role) {
  return landingPathForRole(role) ?? "/";
}

const navItems = [
  { href: "/", id: "home", label: "Home" },
  { href: "/hostels", id: "browse", label: "Hostels" },
  // Beside Hostels because it is the same catalogue seen the other way round —
  // where the hostels *are*, rather than a list of them — and it is the one page
  // that routes you to a door. Bare `/map` opens on every pin with nothing
  // selected; `/map?slug=…&route=1` opens on one hostel with directions running,
  // so a "Directions" link anywhere else can point here.
  { href: "/map", id: "map", label: "Map" },
  // One community for the whole platform, reachable from every header rather
  // than buried in a portal sidebar — signed-out readers included.
  { href: "/community", id: "community", label: "Community" },
  { href: "/compare", id: "compare", label: "Compare" },
  { href: "/register-hostel", id: "register-hostel", label: "Register Hostel" },
  // Top level, next to Register Hostel: it is the question an owner has the
  // moment after they decide to list, and burying it under More made them hunt.
  { href: "/plans-pricing", id: "plans-pricing", label: "Plans & Pricing" },
  // Lands on the public directory; registering is the CTA on that page.
  { href: "/service-providers", id: "providers", label: "Service Providers" },
] as const;

/**
 * An approved provider gets the same header, not a portal — but the
 * hostel-shopping tabs are noise to them: they are not browsing, comparing or
 * listing a hostel, and they cannot register as a provider twice. Those four
 * give way to the one thing they came for.
 */
const providerNavItems = [
  { href: "/", id: "home", label: "Home" },
  { href: "/jobs", id: "jobs", label: "Jobs" },
  { href: "/community", id: "community", label: "Community" },
] as const;

/**
 * `/blog` is deliberately absent.
 *
 * The route still exists and still renders, but its six posts are hardcoded
 * placeholders — invented titles and dates, stock photography, and no article
 * routes behind them, so every card is unclickable. Linking that from the
 * public header ships it as if it were the company's real writing.
 *
 * Put the entry back the moment there is something to read. That needs either a
 * `blog` section in the site config or a `BlogPost` model with detail routes;
 * neither exists today, and both are a feature rather than a copy change.
 */
const moreItems = [
  // Under More rather than top level: the page is reached by its own link from
  // every payment email and receipt, so it does not need to hold a tab. Labelled
  // short — the page itself carries the full "Resident Offer Program" name.
  { href: "/resident-offer-program", id: "offer-program", label: "Offer Program" },
  { href: "/about", id: "about", label: "About Us" },
  { href: "/contact", id: "contact", label: "Contact" },
  { href: "/terms", id: "terms", label: "Terms" },
  { href: "/privacy", id: "privacy", label: "Privacy Policy" },
  { href: "/refund-policy", id: "refund-policy", label: "Refund Policy" },
  { href: "/how-booking-works", id: "how-booking-works", label: "How Booking Works" },
] as const;

export function PublicHeader({ active }: PublicHeaderProps) {
  const router = useRouter();
  // Read from the shared session cache, so a remount on navigation paints the
  // right header at once instead of starting over from "signed out".
  const user = useSessionStore((state) => state.user);
  const setUser = useSessionStore((state) => state.setUser);
  const isSessionChecked = useSessionStore((state) => state.status === "resolved");
  const [menuOpen, setMenuOpen] = useState(false);
  const [getAppOpen, setGetAppOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  // Comes with the session in the same request, so there is no second lookup to
  // wait on and no window where the wrong tabs are on screen.
  const items = user?.isServiceProvider ? providerNavItems : navItems;

  const loadCurrentUser = useCallback(async () => {
    try {
      const response = await checkAuthWithRefresh();
      const payload = (await response.json().catch(() => null)) as MeResponse | null;

      if (!response.ok || !payload?.success) {
        setUser(null);
        return;
      }

      setUser(payload.data.user);
    } catch {
      setUser(null);
    }
  }, [setUser]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void loadCurrentUser();
    }, 0);

    function handleFocus() {
      void loadCurrentUser();
    }

    window.addEventListener("focus", handleFocus);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("focus", handleFocus);
    };
  }, [loadCurrentUser]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    if (menuOpen) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  useEffect(() => {
    function onScroll() {
      setScrolled(window.scrollY > 50);
    }
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  async function handleLogout() {
    await signOutRequest();
    setUser(null);
    setMenuOpen(false);
    router.push("/");
  }

  return (
    <header
      data-scrolled={scrolled ? "" : undefined}
      className={cn("fixed top-0 left-0 right-0 z-50 w-full transition-all duration-300")}
    >
      <div aria-hidden="true" className="public-header-veil" />

      <div className="relative z-10 flex h-16 w-full items-center justify-between gap-2 px-4 md:px-8">
        <Link
          href="/"
          aria-label={PLATFORM_NAME}
          className="flex shrink-0 items-center gap-2 lg:pl-10"
        >
          {/* Full name at the top of the page; folds into the HP mark once it scrolls. */}
          <BrandWordmark folded={scrolled} height={18} />
        </Link>

        {/* Eight destinations plus More only fit from lg, tight there and roomy
            from xl; below that the same list lives in the slide-out menu. */}
        <nav className="hidden h-full items-center gap-4 text-[13px] font-medium text-foreground lg:flex xl:gap-6 xl:text-sm">
          {items.map((item) => (
            <Link
              key={item.id}
              href={item.href}
              className={cn(
                "flex h-full items-center whitespace-nowrap border-b-2 border-transparent pt-1 transition hover:text-brand-teal",
                active === item.id && "border-b-2 border-brand-teal text-brand-teal",
              )}
            >
              {item.label}
            </Link>
          ))}
          <div className="group relative flex h-full items-center">
            <button
              className={cn(
                "flex h-full items-center gap-1 border-b-2 border-transparent pt-1 transition hover:text-brand-teal",
                moreItems.some((i) => i.id === active) &&
                  "border-b-2 border-brand-teal text-brand-teal",
              )}
            >
              More
              <ChevronDown className="size-3.5 transition group-hover:rotate-180" />
            </button>
            <div className="absolute left-1/2 top-full mt-0 -translate-x-1/2 w-44 origin-top scale-95 rounded-lg border border-border bg-surface p-1.5 shadow-lg opacity-0 transition-all duration-150 pointer-events-none group-hover:scale-100 group-hover:opacity-100 group-hover:pointer-events-auto">
              {moreItems.map((item) => (
                <Link
                  key={item.id}
                  href={item.href}
                  className={cn(
                    "block rounded-md px-3 py-2 text-sm text-foreground transition hover:bg-muted",
                    active === item.id && "bg-muted font-semibold",
                  )}
                >
                  {item.label}
                </Link>
              ))}
            </div>
          </div>
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle className="hidden sm:inline-flex" />
          {isSessionChecked ? (
            user ? (
              <div ref={menuRef} className="relative">
                <button
                  onClick={() => setMenuOpen((o) => !o)}
                  className="flex items-center gap-2 rounded-full p-1 pr-3 text-sm font-semibold text-foreground transition-colors duration-200 bg-surface/70 backdrop-blur-md hover:bg-surface/85"
                >
                  {user.image ? (
                    <Image
                      src={user.image}
                      alt=""
                      width={32}
                      height={32}
                      className="size-8 rounded-full object-cover"
                      /*
                       * A resident's card photo is served from an authenticated
                       * route; the image optimizer fetches without their cookies
                       * and would only ever get a 401 back.
                       */
                      unoptimized
                    />
                  ) : (
                    <span className="flex size-8 items-center justify-center rounded-full bg-brand-teal/10 text-sm font-semibold text-brand-teal">
                      {(user.name || user.email || "U").charAt(0).toUpperCase()}
                    </span>
                  )}
                  <span className="hidden max-w-40 truncate text-muted-foreground xl:inline">
                    {user.name || user.email}
                  </span>
                </button>
                {menuOpen && (
                  <div className="absolute right-0 top-full mt-2 w-56 rounded-lg border border-border bg-surface p-1 shadow-lg">
                    <div className="border-b border-border px-3 py-2">
                      <p className="truncate text-sm font-medium text-foreground">
                        {user.name || user.email}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {user.email}
                      </p>
                    </div>
                    {hasDashboard(user.role) && (
                      <Link
                        href={dashboardHrefForRole(user.role)}
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition hover:bg-muted"
                      >
                        <LayoutDashboard className="size-4" />
                        Dashboard
                      </Link>
                    )}
                    <Link
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition hover:bg-muted"
                      href="/bookings"
                      onClick={() => setMenuOpen(false)}
                    >
                      <CalendarCheck className="size-4" />
                      My bookings
                    </Link>
                    {/* Shown to everyone: with no profile yet, the QR modal
                        opens the create form instead. */}
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        requestResidentQr();
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition hover:bg-muted"
                    >
                      <QrCode className="size-4" />
                      {user.isServiceProvider ? "Provider ID card" : "Resident ID card"}
                    </button>
                    {!user.userResidentId && (
                      <button
                        onClick={() => {
                          setMenuOpen(false);
                          requestResidentProfileForm("MANUAL");
                        }}
                        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-semibold text-brand-teal transition hover:bg-brand-teal/10"
                      >
                        <BadgePlus className="size-4" />
                        Create resident ID
                      </button>
                    )}
                    {/* The only place a signed-out-of-any-portal account can
                        turn browser push on — see PublicPushOptIn. */}
                    <PublicPushOptIn onDone={() => setMenuOpen(false)} />
                    <button
                      onClick={() => {
                        setMenuOpen(false);
                        setGetAppOpen(true);
                      }}
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground transition hover:bg-muted"
                    >
                      <Smartphone className="size-4" />
                      Get the app
                    </button>
                    <button
                      onClick={handleLogout}
                      className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm text-red-600 transition hover:bg-red-50"
                    >
                      <LogOut className="size-4" />
                      Logout
                    </button>
                  </div>
                )}
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Link
                  href="/login"
                  className="whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted sm:px-4"
                >
                  Sign In
                </Link>
                <Link
                  href="/signup"
                  className="hidden whitespace-nowrap rounded-lg bg-brand-teal px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:brightness-110 min-[400px]:inline-flex"
                >
                  Sign Up
                </Link>
              </div>
            )
          ) : (
            <span className="inline-flex h-10 w-20 rounded-lg bg-muted sm:w-28 md:w-32" />
          )}
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setNavOpen(true)}
            className="inline-flex size-10 items-center justify-center rounded-lg text-foreground transition hover:bg-muted lg:hidden"
          >
            <Menu className="size-5" />
          </button>
        </div>
      </div>

      <GetAppDialog comingSoon onOpenChange={setGetAppOpen} open={getAppOpen} />

      <Sheet open={navOpen} onOpenChange={setNavOpen}>
        <SheetContent side="right" className="flex w-[280px] flex-col gap-0 p-0 sm:max-w-[280px]">
          <SheetHeader className="shrink-0 border-b border-border px-4 py-3">
            <SheetTitle className="sr-only">Menu</SheetTitle>
            <BrandWordmark height={18} />
          </SheetHeader>
          <nav className="min-h-0 flex-1 overflow-y-auto p-2">
            {[...items, ...moreItems].map((item) => (
              <Link
                key={item.id}
                href={item.href}
                onClick={() => setNavOpen(false)}
                className={cn(
                  "block rounded-lg px-3 py-2.5 text-sm font-medium text-foreground transition hover:bg-muted",
                  active === item.id && "bg-brand-teal/10 font-semibold text-brand-teal",
                )}
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="flex shrink-0 items-center justify-between gap-2 border-t border-border p-3">
            <span className="text-xs text-muted-foreground">Theme</span>
            <ThemeToggle />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mounted here because the header is the one shell on every public page,
          so any page can open the QR / profile modals via a window event.
          Deliberately NOT gated on `isSessionChecked` — it resolves sign-in
          state itself, and gating it meant the modal never opened while the
          session check was still in flight. */}
      <ResidentIdentityCenter onProfileSaved={loadCurrentUser} />
    </header>
  );
}
