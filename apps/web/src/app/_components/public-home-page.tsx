"use client";

import {
  ArrowRight,
  BedDouble,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Heart,
  MapPin,
  Navigation,
  Quote,
  Search,
  ShieldCheck,
  Star,
  Utensils,
  Users,
  WashingMachine,
  Wifi,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

import { useSiteConfig } from "@/components/site-config-provider";
import { browserApi } from "@/lib/browser-api";
import { checkAuthWithRefresh } from "@/lib/auth-check";
import { landingPathForRole } from "@/lib/route-access";
import { Role } from "@/lib/roles";

import type { HostelSummary } from "./public-hostel-types";
import { HostelCard, PublicShell, StatusPill, formatMoney } from "./shared";
import { StarsCtaCard } from "./stars-cta-card";

const PUBLIC_HERO_IMAGE =
  "https://images.unsplash.com/photo-1555854877-bab0e564b8d5?auto=format&fit=crop&w=1600&q=80";

/**
 * These local image paths are intentionally first. Once the supplied images
 * are placed in `public/home/` with the documented names, they override the
 * tasteful remote fallback without another code change.
 */
const HOME_MEDIA = {
  baneshwor: {
    fallback:
      "https://images.unsplash.com/photo-1518005020951-eccb494ad742?auto=format&fit=crop&w=1200&q=85",
    local: "/home/new-baneshwor.png",
  },
  boudha: {
    fallback:
      "https://images.unsplash.com/photo-1548013146-72479768bada?auto=format&fit=crop&w=1200&q=85",
    local: "/home/boudha.png",
  },
  discovery: {
    fallback:
      "https://images.unsplash.com/photo-1616486338812-3dadae4b4ace?auto=format&fit=crop&w=1200&q=85",
    local: "/home/discovery-room.png",
  },
  lazimpat: {
    fallback:
      "https://images.unsplash.com/photo-1538805060514-97d9cc17730c?auto=format&fit=crop&w=1200&q=85",
    local: "/home/lazimpat.png",
  },
  map: {
    fallback:
      "https://images.unsplash.com/photo-1524661135-423995f22d0b?auto=format&fit=crop&w=1600&q=85",
    local: "/home/kathmandu-map.png",
  },
  students: {
    fallback:
      "https://images.unsplash.com/photo-1523240795612-9a054b0db644?auto=format&fit=crop&w=1200&q=85",
    local: "/home/student-stories.png",
  },
  study: {
    fallback:
      "https://images.unsplash.com/photo-1522202176988-66273c2fd55f?auto=format&fit=crop&w=1200&q=85",
    local: "/home/student-study.png",
  },
  thamel: {
    fallback:
      "https://images.unsplash.com/photo-1533130061792-64b345e4a833?auto=format&fit=crop&w=1200&q=85",
    local: "/home/thamel.png",
  },
} as const;

type HomeMediaKey = keyof typeof HOME_MEDIA;

function homeMediaStyle(key: HomeMediaKey) {
  const { fallback, local } = HOME_MEDIA[key];
  return { backgroundImage: `url("${local}"), url("${fallback}")` };
}

const NEIGHBOURHOODS: Array<{
  area: string;
  description: string;
  media: HomeMediaKey;
  name: string;
}> = [
  {
    area: "Thamel",
    description: "A lively student-friendly hub",
    media: "thamel",
    name: "Thamel",
  },
  {
    area: "Boudha",
    description: "A calmer place to settle in",
    media: "boudha",
    name: "Boudha",
  },
  {
    area: "Lazimpat",
    description: "Leafy streets, close to the city",
    media: "lazimpat",
    name: "Lazimpat",
  },
  {
    area: "New Baneshwor",
    description: "Well connected for college life",
    media: "baneshwor",
    name: "New Baneshwor",
  },
];

const DASHBOARD_ROLES = new Set([
  Role.SUPERADMIN,
  Role.PLATFORM_MODERATOR,
  Role.HOSTEL_ADMIN,
  Role.WARDEN,
  Role.RESIDENT,
  Role.GUARDIAN,
]);

function SectionHeading({
  title,
  subtitle,
  action,
  actionHref,
}: {
  title: string;
  subtitle: string;
  action?: string;
  actionHref?: string;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
      <div>
        <h2 className="text-xl font-extrabold text-foreground">{title}</h2>
        <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>
      </div>
      {action && actionHref ? (
        <Link
          className="inline-flex shrink-0 items-center gap-1 text-xs font-bold text-brand-teal hover:underline"
          href={actionHref}
        >
          {action} <ArrowRight className="size-3.5" />
        </Link>
      ) : null}
    </div>
  );
}

/**
 * One row of hostel cards. Every row on this page is a slice of the same
 * server-rendered set, so they share one empty treatment — a row that simply
 * renders nothing reads as a broken page.
 */
function HostelRow({
  emptyLabel,
  hostels,
}: {
  emptyLabel: string;
  hostels: HostelSummary[];
}) {
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
      {hostels.length === 0 ? (
        <div className="col-span-full rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {emptyLabel}
        </div>
      ) : (
        hostels.map((hostel) => <HostelCard hostel={hostel} key={hostel.id} />)
      )}
    </div>
  );
}

const COMPARISON_AMENITIES = [
  { Icon: Wifi, label: "Wi-Fi", matches: /wifi|wi-fi|internet/i },
  { Icon: Utensils, label: "Meals", matches: /food|meal|mess|dining|kitchen/i },
  { Icon: WashingMachine, label: "Laundry", matches: /laundry|washing/i },
] as const;

function comparisonAmenities(hostel: HostelSummary) {
  const facilityText = hostel.facilities.join(" ");
  const amenities = COMPARISON_AMENITIES.filter(({ matches }) => matches.test(facilityText));

  if (hostel.foodScore > 0 && !amenities.some(({ label }) => label === "Meals")) {
    amenities.push(COMPARISON_AMENITIES[1]);
  }

  return amenities.length
    ? amenities.slice(0, 3)
    : [{ Icon: ShieldCheck, label: hostel.verified ? "Verified" : "Details available" }];
}

function ComparisonHostelCard({
  hostel,
  prominence,
}: {
  hostel: HostelSummary;
  prominence: "side" | "featured";
}) {
  const amenities = comparisonAmenities(hostel);
  const location = hostel.address || [hostel.area, hostel.city].filter(Boolean).join(", ");
  const isFeatured = prominence === "featured";

  return (
    <Link
      aria-label={`View ${hostel.name}`}
      className={`group block overflow-hidden rounded-2xl border border-border/80 bg-card shadow-[0_14px_38px_rgba(15,77,64,0.12)] transition duration-300 hover:-translate-y-1 hover:border-brand-teal/40 hover:shadow-[0_20px_45px_rgba(15,77,64,0.18)] ${
        isFeatured ? "p-2" : "p-2"
      }`}
      href={`/hostels/${hostel.slug}`}
    >
      <div
        className={`relative overflow-hidden rounded-xl bg-muted bg-cover bg-center ${
          isFeatured ? "h-36" : "h-28"
        }`}
        style={{ backgroundImage: `url("${hostel.image}")` }}
      >
        <div className="absolute inset-0 bg-gradient-to-t from-black/25 via-transparent to-transparent" />
        {hostel.verified ? (
          <span className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-brand-teal px-2 py-1 text-[9px] font-extrabold text-white shadow-sm">
            <ShieldCheck className="size-3" /> Verified
          </span>
        ) : null}
      </div>
      <div className={isFeatured ? "px-1 pb-1 pt-3" : "px-1 pb-1 pt-2.5"}>
        <div className="flex items-start justify-between gap-2">
          <h3 className={`line-clamp-1 font-extrabold text-foreground ${isFeatured ? "text-sm" : "text-xs"}`}>
            {hostel.name}
          </h3>
          <span className="inline-flex shrink-0 items-center gap-0.5 text-[10px] font-bold text-warning">
            <Star className="size-3 fill-warning" /> {hostel.rating.toFixed(1)}
          </span>
        </div>
        <p className="mt-1 inline-flex max-w-full items-center gap-1 truncate text-[10px] font-medium text-muted-foreground">
          <MapPin className="size-3 shrink-0" />
          <span className="truncate">{location}</span>
        </p>
        <div className={`flex items-baseline gap-1 ${isFeatured ? "mt-3" : "mt-2"}`}>
          <span className={`font-extrabold tracking-tight text-foreground ${isFeatured ? "text-base" : "text-sm"}`}>
            {formatMoney(hostel.price)}
          </span>
          <span className="text-[10px] font-medium text-muted-foreground">/ month</span>
        </div>
        <p className="mt-1 text-[10px] font-medium text-muted-foreground">
          {hostel.reviews > 0 ? `${hostel.reviews} reviews` : "New listing"}
        </p>
        <div className={`mt-3 flex flex-wrap gap-1.5 ${isFeatured ? "" : "hidden"}`}>
          {amenities.map(({ Icon, label }) => (
            <span
              className="inline-flex items-center gap-1 rounded-full bg-brand-teal-soft/45 px-2 py-1 text-[9px] font-bold text-brand-teal"
              key={label}
            >
              <Icon className="size-3" /> {label}
            </span>
          ))}
        </div>
      </div>
    </Link>
  );
}

function HostelSnapshot({ hostel }: { hostel?: HostelSummary }) {
  if (!hostel) return null;

  return (
    <Link
      className="group flex gap-3 rounded-xl border border-border/80 bg-card p-3 shadow-sm transition hover:-translate-y-0.5 hover:border-brand-teal/40 hover:shadow-md"
      href={`/hostels/${hostel.slug}`}
    >
      <div
        className="size-16 shrink-0 rounded-lg bg-cover bg-center"
        style={{ backgroundImage: `url("${hostel.image}")` }}
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-xs font-extrabold text-foreground">{hostel.name}</p>
          {hostel.verified ? (
            <ShieldCheck className="size-3.5 shrink-0 text-brand-teal" />
          ) : null}
        </div>
        <p className="mt-1 truncate text-[11px] font-medium text-muted-foreground">
          {hostel.area}, {hostel.city}
        </p>
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="text-xs font-extrabold text-foreground">
            {formatMoney(hostel.price)}
          </span>
          <span className="inline-flex items-center gap-0.5 text-[11px] font-bold text-warning">
            <Star className="size-3 fill-warning" /> {hostel.rating.toFixed(1)}
          </span>
        </div>
      </div>
    </Link>
  );
}

function PublicHomePageContent({ hostels }: { hostels: HostelSummary[] }) {
  const router = useRouter();
  const pageRef = useRef<HTMLDivElement>(null);
  const { hero, identity, platformStats, trustPoints } = useSiteConfig();
  const [searchVal, setSearchVal] = useState("");
  const [searching, setSearching] = useState(false);
  const [selectedCity, setSelectedCity] = useState<string | null>(null);
  const [comparisonStart, setComparisonStart] = useState(0);

  /**
   * Resolve the typed sentence into listing filters before navigating.
   * Keyword detection answers most queries server-side for free; only what it
   * cannot explain reaches the LLM, and only while the visitor has quota. Any
   * failure just falls through to a plain ?search= deep link, so the button
   * never dead-ends.
   */
  const runSearch = useCallback(async () => {
    const query = searchVal.trim();
    if (!query) {
      router.push("/hostels");
      return;
    }

    setSearching(true);
    try {
      const { filters } = await browserApi<{ filters: Record<string, unknown> }>(
        "/api/v1/public/search/parse",
        { body: JSON.stringify({ query }), method: "POST" },
      );

      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined && value !== null && value !== "") {
          params.set(key, String(value));
        }
      }
      // The listing page ANDs `search` with every other filter rather than
      // just displaying it, so it must only carry a term the parse actually
      // resolved to free text (a hostel/college name it couldn't place
      // elsewhere). When the sentence resolved to structured filters instead
      // (area, facility, budget, ...), those already explain the query —
      // layering the raw sentence back in as a literal substring match would
      // just cancel them out (e.g. "hostel near Ghattekulo" correctly
      // resolves to area=Ghattekulo, but re-adding the full sentence as
      // search text means no hostel's name/area contains that exact phrase).
      if (params.has("q")) {
        params.set("search", String(filters.q));
        params.delete("q");
      }

      router.push(`/hostels?${params.toString()}`);
    } catch {
      router.push(`/hostels?search=${encodeURIComponent(query)}`);
    } finally {
      setSearching(false);
    }
  }, [router, searchVal]);

  useEffect(() => {
    async function redirectIfDashboardRole() {
      try {
        const response = await checkAuthWithRefresh();
        if (!response.ok) return;
        const payload = await response.json().catch(() => null);
        if (!payload?.success) return;
        const role = payload.data.user.role as Role;
        if (DASHBOARD_ROLES.has(role)) {
          const path = landingPathForRole(role);
          if (path) router.replace(path);
        }
      } catch {
        // not authenticated — stay on page
      }
    }
    void redirectIfDashboardRole();
  }, [router]);

  useLayoutEffect(() => {
    const root = pageRef.current;
    if (!root || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    gsap.registerPlugin(ScrollTrigger);
    const context = gsap.context(() => {
      gsap.utils.toArray<HTMLElement>("[data-home-parallax]").forEach((visual) => {
        const section = visual.closest<HTMLElement>("section") ?? visual;
        const amount = visual.dataset.parallaxDirection === "down" ? 7 : -7;

        gsap.fromTo(
          visual,
          { yPercent: amount },
          {
            ease: "none",
            scrollTrigger: {
              end: "bottom top",
              scrub: 0.65,
              start: "top bottom",
              trigger: section,
            },
            yPercent: -amount,
          },
        );
      });
    }, root);

    return () => context.revert();
  }, []);

  const byRating = useMemo(
    () => [...hostels].sort((a, b) => b.rating - a.rating || b.reviews - a.reviews),
    [hostels],
  );

  // Memoised so the comparison memo below, which keys on it, can ever hold.
  const featuredHostels = useMemo(() => byRating.slice(0, 4), [byRating]);
  const cityOptions = useMemo(
    () => [...new Set(hostels.map((hostel) => hostel.city).filter(Boolean))].slice(0, 5),
    [hostels],
  );
  const activeCity =
    selectedCity ?? (cityOptions.includes("Kathmandu") ? "Kathmandu" : cityOptions[0]);
  const cityHostels = useMemo(
    () => byRating.filter((hostel) => hostel.city === activeCity).slice(0, 4),
    [activeCity, byRating],
  );
  const heroHostel = featuredHostels[0];
  const comparisonHostels = featuredHostels;
  const visibleComparisonHostels = useMemo(() => {
    if (!comparisonHostels.length) return [];

    return Array.from(
      { length: Math.min(3, Math.max(3, comparisonHostels.length)) },
      (_, offset) => comparisonHostels[(comparisonStart + offset) % comparisonHostels.length],
    );
  }, [comparisonHostels, comparisonStart]);
  const assurancePoints = trustPoints.slice(0, 3);
  /*
   * The map band's numbers, counted rather than written: verified listings and
   * the average rating come from the hostels on this page, residents from the
   * platform count (which is withheld until it is big enough to say out loud).
   * A figure with nothing behind it is dropped, not faked.
   */
  const bandStats = useMemo(() => {
    const rated = hostels.filter((hostel) => hostel.reviews > 0);
    const verified = hostels.filter((hostel) => hostel.verified).length;
    const residents = platformStats.find((stat) => stat.label.startsWith("Residents"));
    const average = rated.length
      ? rated.reduce((sum, hostel) => sum + hostel.rating, 0) / rated.length
      : 0;

    return [
      verified > 0
        ? { Icon: ShieldCheck, label: "Verified Hostels", value: verified.toLocaleString("en-IN") }
        : null,
      residents
        ? { Icon: Users, label: "Residents", value: residents.value.toLocaleString("en-IN") }
        : null,
      average > 0 ? { Icon: Star, label: "Average Rating", value: average.toFixed(1) } : null,
    ].filter((stat) => stat !== null);
  }, [hostels, platformStats]);

  const moveComparison = (direction: -1 | 1) => {
    if (comparisonHostels.length < 2) return;
    setComparisonStart(
      (current) =>
        (current + direction + comparisonHostels.length) % comparisonHostels.length,
    );
  };

  return (
    <PublicShell>
      <div ref={pageRef}>
        <section className="relative w-full overflow-hidden bg-background -mt-16">
          {/* Right side background image with smooth fade on the left */}
          <div className="absolute right-0 top-0 hidden h-full w-[54%] lg:block">
            <div
              className="h-full w-full bg-cover bg-center"
              style={{ backgroundImage: `url("${PUBLIC_HERO_IMAGE}")` }}
            />
            {/* Fading overlay from white to transparent (left-to-right) */}
            <div className="absolute inset-y-0 left-0 w-48 bg-gradient-to-r from-background via-background/80 to-transparent" />

            {/* Slider Dots */}
            <div className="absolute bottom-10 left-[45%] flex gap-2">
              <span className="size-2 rounded-full bg-background" />
              <span className="size-2 rounded-full bg-background/40" />
            </div>
          </div>

          <div className="mx-auto relative z-10 grid max-w-[1448px] gap-6 px-4 pt-20 pb-10 sm:px-6 sm:pt-24 lg:min-h-[75vh] lg:gap-10 lg:pt-32 lg:pb-12 lg:grid-cols-[0.88fr_1fr] lg:items-center">
            <div className="py-4 lg:py-10">
              <span className="inline-flex items-center gap-2 rounded-full border border-border bg-muted px-3.5 py-1.5 text-xs font-semibold text-foreground shadow-sm">
                <ShieldCheck className="size-4 text-brand-teal" />
                Trusted by Students & Families
              </span>
              <h1 className="mt-6 max-w-xl font-heading text-[2.25rem] sm:mt-8 sm:text-5xl lg:text-[56px] font-extrabold leading-[1.15] text-foreground">
                {hero.headline}
              </h1>
              <p className="mt-5 max-w-md text-sm leading-relaxed text-muted-foreground">
                {hero.subheadline}
              </p>
              <div className="mt-6 flex max-w-lg items-center gap-2 sm:mt-8 rounded-lg border border-border bg-card p-1.5 shadow-md focus-within:border-brand-teal focus-within:ring-2 focus-within:ring-brand-teal/15 transition">
                <Search className="ml-2 size-5 shrink-0 text-muted-foreground sm:ml-3" />
                <input
                  aria-label="Search hostels"
                  className="h-11 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
                  onChange={(e) => setSearchVal(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void runSearch();
                  }}
                  placeholder={hero.searchPlaceholder}
                  value={searchVal}
                />
                <button
                  className="shrink-0 rounded-md bg-brand-teal px-4 py-3 text-sm sm:px-7 font-bold text-white transition hover:brightness-105 disabled:opacity-70"
                  disabled={searching}
                  onClick={() => void runSearch()}
                  type="button"
                >
                  {searching ? "Searching..." : "Search"}
                </button>
              </div>
              <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 text-xs font-bold sm:mt-8 text-foreground">
                {[
                  { label: "Verified Hostels", icon: CheckCircle2 },
                  { label: "Trusted by Students", icon: CheckCircle2 },
                  { label: "Easy & Secure", icon: CheckCircle2 },
                ].map((item) => (
                  <span className="inline-flex items-center gap-1.5" key={item.label}>
                    <item.icon className="size-4 text-brand-teal" />
                    {item.label}
                  </span>
                ))}
              </div>
            </div>

            <div className="relative lg:flex lg:justify-end lg:py-10 lg:pr-8">
              {/* Below lg the half-page photo is hidden, so the hero carries its
                own: a rounded panel with the card straddling its bottom edge. */}
              <div
                aria-hidden
                className="h-56 rounded-2xl bg-cover bg-center sm:h-72 md:h-80 lg:hidden"
                style={{ backgroundImage: `url("${PUBLIC_HERO_IMAGE}")` }}
              />
              <div className="relative mx-3 -mt-16 flex max-w-[360px] gap-4 rounded-xl border border-border/80 bg-card/95 p-4 shadow-2xl backdrop-blur-sm transition hover:scale-[1.01] sm:mx-6 lg:m-0 lg:mt-36 lg:w-[320px] lg:max-w-none">
                <div
                  className="size-20 rounded-lg bg-cover bg-center shrink-0 shadow-sm sm:size-24"
                  style={{
                    backgroundImage: `url("${heroHostel?.image ?? PUBLIC_HERO_IMAGE}")`,
                  }}
                />
                <div className="flex-1 flex flex-col justify-between py-0.5 min-w-0">
                  <div>
                    <h4
                      className="font-bold text-sm text-foreground truncate"
                      title={heroHostel?.name ?? "Verified hostel"}
                    >
                      {heroHostel?.name ?? "Verified hostel"}
                    </h4>
                    <div className="mt-1 flex flex-wrap items-center gap-1 text-[10px]">
                      <Star className="size-3 fill-warning text-warning" />
                      <span className="font-bold text-foreground">
                        {heroHostel?.rating ? heroHostel.rating.toFixed(1) : "New"}
                      </span>
                      <span className="text-muted-foreground font-normal">
                        ({heroHostel?.reviews ?? 0})
                      </span>
                      <StatusPill
                        tone="success"
                        className="ml-auto text-[8px] py-0 px-1 rounded-sm font-bold"
                      >
                        Verified
                      </StatusPill>
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground font-semibold truncate">
                      {heroHostel
                        ? `${heroHostel.area}, ${heroHostel.city}`
                        : "Published hostels appear here"}
                    </p>
                  </div>
                  <p className="mt-1 font-bold text-foreground text-xs">
                    {heroHostel ? formatMoney(heroHostel.price) : "NPR --"}{" "}
                    <span className="font-normal text-[10px] text-muted-foreground">
                      / month
                    </span>
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1448px] px-4 pb-14 pt-4 sm:px-6">
          <SectionHeading
            action="View all hostels"
            actionHref="/hostels"
            subtitle="Stay with confidence — real photos, verified details and transparent pricing."
            title="Featured hostels"
          />
          <HostelRow
            emptyLabel="No hostels are published yet. Check back soon."
            hostels={featuredHostels}
          />
        </section>

        <section className="bg-surface py-14">
          <div className="mx-auto max-w-[1448px] px-4 sm:px-6">
            <div className="flex flex-wrap items-end justify-between gap-4">
              <div>
                <h2 className="text-xl font-extrabold text-foreground">
                  {activeCity ? `Hostels in ${activeCity}` : "Hostels by city"}
                </h2>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Browse verified places in the city you&apos;re planning to live in.
                </p>
              </div>
              <Link
                className="inline-flex shrink-0 items-center gap-1 text-xs font-bold text-brand-teal hover:underline"
                href="/hostels/in"
              >
                View all cities <ArrowRight className="size-3.5" />
              </Link>
            </div>
            {cityOptions.length > 1 ? (
              <div className="mt-5 flex flex-wrap gap-2">
                {cityOptions.map((city) => (
                  <button
                    className={
                      city === activeCity
                        ? "rounded-full border border-brand-teal bg-brand-teal px-3.5 py-1.5 text-xs font-bold text-white"
                        : "rounded-full border border-border bg-card px-3.5 py-1.5 text-xs font-bold text-foreground transition hover:border-brand-teal/40 hover:text-brand-teal"
                    }
                    key={city}
                    onClick={() => setSelectedCity(city)}
                    type="button"
                  >
                    {city}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="mt-7">
              <HostelRow
                emptyLabel={
                  activeCity
                    ? `No verified hostels are listed in ${activeCity} yet.`
                    : "No hostels are published yet. Check back soon."
                }
                hostels={cityHostels}
              />
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1448px] px-4 py-2 sm:px-6 sm:py-6">
          <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-sm lg:grid lg:grid-cols-[1.02fr_1.18fr]">
            <div className="relative min-h-[360px] overflow-hidden">
              <div
                aria-hidden
                className="absolute -inset-x-4 -inset-y-8 scale-110 bg-cover bg-center will-change-transform"
                data-home-parallax
                style={homeMediaStyle("discovery")}
              />
              <div className="absolute inset-0 bg-gradient-to-t from-black/65 via-black/10 to-transparent" />
              <p className="absolute bottom-7 left-7 max-w-[12rem] font-heading text-2xl font-extrabold leading-tight text-white sm:text-3xl">
                More than a room, it&apos;s your next chapter.
              </p>
            </div>

            <div className="grid gap-6 p-7 sm:p-9 lg:grid-cols-[1fr_250px] lg:items-center">
              <div>
                <div className="flex flex-wrap gap-2 text-[10px] font-bold uppercase tracking-wide text-brand-teal">
                  <span className="rounded-full bg-brand-teal-soft px-2.5 py-1">
                    Comfort
                  </span>
                  <span className="rounded-full bg-brand-teal-soft px-2.5 py-1">
                    Safety
                  </span>
                  <span className="rounded-full bg-brand-teal-soft px-2.5 py-1">
                    Community
                  </span>
                </div>
                <h2 className="mt-5 max-w-md font-heading text-3xl font-extrabold leading-tight text-foreground">
                  Find a place that feels right.
                </h2>
                <p className="mt-4 max-w-lg text-sm leading-relaxed text-muted-foreground">
                  Explore hostels that match your routine, budget and location. See rooms,
                  compare essentials and make your choice with clarity.
                </p>
                <Link
                  className="mt-6 inline-flex items-center gap-2 rounded-lg bg-brand-teal px-4 py-2.5 text-sm font-bold text-white transition hover:brightness-105"
                  href="/hostels"
                >
                  Explore hostels <ArrowRight className="size-4" />
                </Link>
                <div className="mt-6 flex flex-wrap gap-x-5 gap-y-2 text-xs font-semibold text-muted-foreground">
                  <span className="inline-flex items-center gap-1.5">
                    <Wifi className="size-3.5 text-brand-teal" /> Wi-Fi
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <BedDouble className="size-3.5 text-brand-teal" /> Room choices
                  </span>
                  <span className="inline-flex items-center gap-1.5">
                    <ShieldCheck className="size-3.5 text-brand-teal" /> Verified details
                  </span>
                </div>
              </div>
              <div className="grid gap-3">
                <HostelSnapshot hostel={featuredHostels[0]} />
                <HostelSnapshot hostel={featuredHostels[1]} />
                <Link
                  className="group relative min-h-[112px] overflow-hidden rounded-xl p-4"
                  href="/map"
                >
                  <span
                    aria-hidden
                    className="absolute -inset-x-3 -inset-y-5 scale-110 bg-cover bg-center will-change-transform"
                    data-home-parallax
                    style={homeMediaStyle("map")}
                  />
                  <div className="absolute inset-0 bg-white/65 transition group-hover:bg-white/50" />
                  <span className="relative flex h-full flex-col justify-between">
                    <span className="inline-flex size-8 items-center justify-center rounded-full bg-brand-teal text-white shadow-sm">
                      <MapPin className="size-4" />
                    </span>
                    <span className="text-xs font-extrabold text-brand-teal">
                      See hostels on the map <ArrowRight className="inline size-3.5" />
                    </span>
                  </span>
                </Link>
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1448px] px-4 py-14 sm:px-6">
          <SectionHeading
            action="View all cities"
            actionHref="/hostels/in"
            subtitle="Explore some of Kathmandu's most convenient places to stay."
            title="Popular around Kathmandu"
          />
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {NEIGHBOURHOODS.map((neighbourhood) => (
              <Link
                className="group relative min-h-48 overflow-hidden rounded-xl shadow-sm"
                href={{ pathname: "/hostels", query: { area: neighbourhood.area } }}
                key={neighbourhood.area}
              >
                <span
                  aria-hidden
                  className="absolute -inset-x-3 -inset-y-6 scale-110 bg-cover bg-center will-change-transform"
                  data-home-parallax
                  data-parallax-direction="down"
                  style={homeMediaStyle(neighbourhood.media)}
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/15 to-transparent transition group-hover:from-black/90" />
                <span className="absolute inset-x-0 bottom-0 flex items-end justify-between gap-4 p-5 text-white">
                  <span>
                    <span className="block text-lg font-extrabold">
                      {neighbourhood.name}
                    </span>
                    <span className="mt-0.5 block text-xs text-white/80">
                      {neighbourhood.description}
                    </span>
                  </span>
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/90 text-brand-teal transition group-hover:translate-x-0.5">
                    <ArrowRight className="size-4" />
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-[1448px] px-4 py-14 sm:px-6">
          <div className="overflow-hidden rounded-[28px] border border-brand-teal/10 bg-brand-teal-soft/35 px-6 py-10 shadow-[0_16px_45px_rgba(15,77,64,0.05)] sm:px-10 sm:py-12 lg:px-12">
            <div className="grid gap-10 lg:grid-cols-[0.7fr_1.3fr] lg:items-center">
              <div>
                <span className="inline-flex items-center gap-2 text-xs font-bold text-brand-teal">
                  <span className="flex size-7 items-center justify-center rounded-full bg-brand-teal/10">
                    <ShieldCheck className="size-4" />
                  </span>
                  Compare before you visit
                </span>
                <h2 className="mt-5 max-w-md font-heading text-3xl font-extrabold leading-[1.12] text-foreground sm:text-4xl">
                  See the difference. Choose with confidence.
                </h2>
                <p className="mt-5 max-w-md text-sm leading-relaxed text-muted-foreground">
                  Compare prices, facilities, ratings and location side by side. Find the
                  perfect hostel for your needs.
                </p>
                <Link
                  className="mt-7 inline-flex items-center gap-2 rounded-xl bg-brand-teal px-5 py-3 text-sm font-bold text-white shadow-sm transition hover:-translate-y-0.5 hover:brightness-105"
                  href="/compare"
                >
                  Compare hostels <ArrowRight className="size-4" />
                </Link>
              </div>

              {visibleComparisonHostels.length ? (
                <div className="relative">
                  <div className="grid gap-4 sm:grid-cols-3 lg:hidden">
                    {visibleComparisonHostels.map((hostel, index) => (
                      <ComparisonHostelCard
                        hostel={hostel}
                        key={`${hostel.id}-mobile-${index}`}
                        prominence="featured"
                      />
                    ))}
                  </div>

                  <div className="relative hidden min-h-[382px] items-center lg:flex">
                    <button
                      aria-label="Show previous hostels"
                      className="absolute left-0 z-30 flex size-10 items-center justify-center rounded-full border border-border bg-card text-brand-teal shadow-sm transition hover:border-brand-teal hover:bg-brand-teal hover:text-white disabled:cursor-default disabled:opacity-40"
                      disabled={comparisonHostels.length < 2}
                      onClick={() => moveComparison(-1)}
                      type="button"
                    >
                      <ChevronLeft className="size-5" />
                    </button>
                    <div className="absolute left-11 top-7 z-10 w-[31%] -rotate-[5deg] transition-transform duration-500 hover:rotate-0">
                      <ComparisonHostelCard hostel={visibleComparisonHostels[0]} prominence="side" />
                    </div>
                    <div className="absolute left-1/2 top-0 z-20 w-[45%] min-w-[270px] -translate-x-1/2">
                      <ComparisonHostelCard hostel={visibleComparisonHostels[1]} prominence="featured" />
                    </div>
                    <div className="absolute right-11 top-7 z-10 w-[31%] rotate-[5deg] transition-transform duration-500 hover:rotate-0">
                      <ComparisonHostelCard hostel={visibleComparisonHostels[2]} prominence="side" />
                    </div>
                    <button
                      aria-label="Show next hostels"
                      className="absolute right-0 z-30 flex size-10 items-center justify-center rounded-full border border-border bg-card text-brand-teal shadow-sm transition hover:border-brand-teal hover:bg-brand-teal hover:text-white disabled:cursor-default disabled:opacity-40"
                      disabled={comparisonHostels.length < 2}
                      onClick={() => moveComparison(1)}
                      type="button"
                    >
                      <ChevronRight className="size-5" />
                    </button>
                  </div>
                  <div className="mt-5 flex justify-center gap-2 lg:mt-1">
                    {comparisonHostels.map((hostel, index) => (
                      <button
                        aria-label={`Show ${hostel.name}`}
                        className={`h-2 rounded-full transition ${
                          comparisonStart === index ? "w-5 bg-brand-teal" : "w-2 bg-brand-teal/20 hover:bg-brand-teal/45"
                        }`}
                        key={hostel.id}
                        onClick={() => setComparisonStart(index)}
                        type="button"
                      />
                    ))}
                  </div>
                </div>
              ) : (
                <div className="rounded-2xl border border-dashed border-brand-teal/35 bg-card/60 p-8 text-center text-sm text-muted-foreground">
                  More verified hostels will appear here as they are published.
                </div>
              )}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1448px] px-4 py-14 sm:px-6">
          <div className="relative isolate min-h-[470px] overflow-hidden rounded-2xl border border-border/80 bg-[#f3f8f5] shadow-[0_18px_45px_rgba(15,77,64,0.1)] sm:min-h-[500px]">
            <div
              aria-hidden
              className="absolute -inset-x-5 -inset-y-8 scale-110 bg-cover bg-center will-change-transform"
              data-home-parallax
              data-parallax-direction="down"
              style={homeMediaStyle("map")}
            />
            <div className="absolute inset-0 bg-gradient-to-r from-background via-background/95 via-42% to-background/5" />
            <div className="absolute inset-0 bg-gradient-to-t from-background/20 via-transparent to-white/15" />

            <div aria-hidden className="pointer-events-none absolute inset-0 hidden lg:block">
              <svg
                className="absolute left-[48%] top-[13%] h-[65%] w-[37%] overflow-visible"
                fill="none"
                viewBox="0 0 500 330"
              >
                <path
                  d="M44 274 C84 256 89 287 125 269 C163 249 142 222 181 209 C218 197 236 220 262 189 C286 161 276 129 309 113 C350 94 365 104 391 69 C413 39 440 59 457 35"
                  stroke="rgba(255,255,255,0.95)"
                  strokeLinecap="round"
                  strokeWidth="11"
                />
                <path
                  d="M44 274 C84 256 89 287 125 269 C163 249 142 222 181 209 C218 197 236 220 262 189 C286 161 276 129 309 113 C350 94 365 104 391 69 C413 39 440 59 457 35"
                  stroke="#078557"
                  strokeLinecap="round"
                  strokeWidth="5"
                />
              </svg>

              <span className="absolute left-[52%] top-[55%] flex size-14 items-center justify-center rounded-full bg-brand-teal text-white shadow-[0_8px_20px_rgba(5,105,68,0.35)]">
                <MapPin className="size-8 fill-brand-teal stroke-white" />
              </span>
              <span className="absolute left-[73.5%] top-[13%] flex size-11 items-center justify-center rounded-full bg-brand-teal text-white shadow-[0_8px_18px_rgba(5,105,68,0.28)]">
                <MapPin className="size-6 fill-brand-teal stroke-white" />
              </span>
              <span className="absolute bottom-8 right-8 inline-flex items-center gap-2 rounded-xl bg-card/95 px-4 py-3 text-xs font-bold text-foreground shadow-lg backdrop-blur-sm">
                <span className="flex size-6 items-center justify-center rounded-full bg-brand-teal-soft text-brand-teal">
                  <MapPin className="size-3.5 fill-brand-teal" />
                </span>
                Your location
              </span>

              {featuredHostels.slice(1, 4).map((hostel, index) => (
                <span
                  className={[
                    "absolute flex size-13 items-center justify-center rounded-xl bg-card p-1 shadow-[0_8px_18px_rgba(15,77,64,0.18)] after:absolute after:-bottom-1 after:left-1/2 after:size-3 after:-translate-x-1/2 after:rotate-45 after:bg-card",
                    "left-[46%] top-[56%]",
                    "right-[15%] top-[23%]",
                    "right-[20%] top-[65%]",
                  ][index]}
                  key={hostel.id}
                >
                  <span
                    className="relative z-10 size-full rounded-lg bg-cover bg-center"
                    style={{ backgroundImage: `url(\"${hostel.image}\")` }}
                  />
                </span>
              ))}
            </div>

            {heroHostel ? (
            <div className="absolute left-[48%] top-[16%] z-10 hidden w-[310px] lg:block xl:left-[50%]">
              <Link
                className="group flex gap-3 rounded-xl border border-white/80 bg-card/95 p-3 shadow-[0_14px_32px_rgba(15,77,64,0.16)] backdrop-blur-sm transition hover:-translate-y-0.5 hover:shadow-[0_18px_38px_rgba(15,77,64,0.23)]"
                href={`/hostels/${heroHostel.slug}`}
              >
                <span
                  className="size-[72px] shrink-0 -rotate-[5deg] rounded-lg border-4 border-card bg-cover bg-center shadow-md"
                  style={{ backgroundImage: `url(\"${heroHostel.image || HOME_MEDIA.discovery.local}\")` }}
                />
                <span className="min-w-0 flex-1 py-0.5">
                  <span className="flex items-start justify-between gap-2">
                    <span className="line-clamp-1 text-xs font-extrabold text-foreground">
                      {heroHostel.name}
                    </span>
                    {heroHostel.verified ? (
                      <ShieldCheck className="size-3.5 shrink-0 text-brand-teal" />
                    ) : null}
                  </span>
                  <span className="mt-1 flex items-center gap-1 text-[11px] font-bold text-muted-foreground">
                    <Star className="size-3 fill-warning text-warning" />
                    {heroHostel.reviews > 0 ? heroHostel.rating.toFixed(1) : "New"}
                    {heroHostel.reviews > 0 ? (
                      <span className="font-medium">({heroHostel.reviews})</span>
                    ) : null}
                  </span>
                  <span className="mt-2 block text-xs font-extrabold text-foreground">
                    {formatMoney(heroHostel.price)}
                    <span className="font-medium text-muted-foreground"> / month</span>
                  </span>
                  <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-extrabold text-brand-teal group-hover:underline">
                    View details <ArrowRight className="size-3" />
                  </span>
                </span>
              </Link>
            </div>
            ) : null}

            <div className="relative z-20 flex min-h-[470px] max-w-[495px] flex-col justify-center px-7 py-10 sm:min-h-[500px] sm:px-10">
              <span className="inline-flex w-fit items-center gap-2 rounded-full border border-brand-teal/10 bg-card/80 px-3 py-1.5 text-[11px] font-bold text-brand-teal shadow-sm backdrop-blur-sm">
                <span className="flex size-5 items-center justify-center rounded-full bg-brand-teal text-white">
                  <Navigation className="size-3" />
                </span>
                Find hostels near you
              </span>
              <h2 className="mt-5 font-heading text-3xl font-extrabold leading-[1.12] text-foreground sm:text-[2.6rem]">
                Your next hostel is closer than you think
              </h2>
              <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted-foreground">
                Explore nearby hostels, check real-time availability, get directions and
                book in just a few taps.
              </p>
              <Link
                className="mt-6 inline-flex w-fit items-center gap-2 rounded-lg bg-brand-teal px-4 py-2.5 text-sm font-bold text-white shadow-sm transition hover:brightness-105"
                href="/map"
              >
                Open Map <ArrowRight className="size-4" />
              </Link>
              {bandStats.length > 0 ? (
              <div className="mt-9 grid grid-cols-3 border-t border-border/70 pt-6">
                {bandStats.map(({ Icon, label, value }, index) => (
                  <div
                    className={index === 0 ? "pr-3" : "border-l border-border/70 px-3"}
                    key={label}
                  >
                    <div className="flex items-center gap-2 text-brand-teal">
                      <Icon className={label === "Average Rating" ? "size-5 fill-brand-teal" : "size-5"} />
                      <span className="text-base font-extrabold text-foreground sm:text-lg">
                        {value}
                        {label === "Average Rating" ? <span className="text-brand-teal">★</span> : null}
                      </span>
                    </div>
                    <p className="mt-1 text-[9px] font-bold leading-tight text-muted-foreground sm:text-[10px]">
                      {label}
                    </p>
                  </div>
                ))}
              </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1448px] px-4 pb-14 sm:px-6">
          <div className="grid overflow-hidden rounded-2xl border border-border bg-surface shadow-sm lg:grid-cols-[1.02fr_1fr]">
            <div className="relative min-h-[320px] overflow-hidden">
              <div
                aria-hidden
                className="absolute -inset-x-4 -inset-y-8 scale-110 bg-cover bg-center will-change-transform"
                data-home-parallax
                style={homeMediaStyle("students")}
              />
            </div>
            <div className="grid gap-6 p-7 sm:p-9 md:grid-cols-[1fr_170px] md:items-center">
              <div>
                <span className="inline-flex items-center gap-2 text-xs font-bold text-brand-teal">
                  <Heart className="size-4" /> Verified &amp; trusted
                </span>
                <h2 className="mt-4 font-heading text-3xl font-extrabold leading-tight text-foreground">
                  Real stories. Happy students.
                </h2>
                <blockquote className="mt-4 border-l-2 border-brand-teal pl-4 text-sm leading-relaxed text-muted-foreground">
                  <Quote className="mb-2 size-4 text-brand-teal" />
                  “Clear details and real hostel photos made it much easier to choose
                  where to stay.”
                </blockquote>
                <div className="mt-6 grid gap-3 sm:grid-cols-3 md:grid-cols-1">
                  {assurancePoints.map((point) => (
                    <div className="flex gap-2.5" key={point.title}>
                      <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-brand-teal" />
                      <div>
                        <p className="text-xs font-extrabold text-foreground">
                          {point.title}
                        </p>
                        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                          {point.description}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="relative min-h-48 overflow-hidden rounded-xl">
                <div
                  aria-hidden
                  className="absolute -inset-x-3 -inset-y-5 scale-110 bg-cover bg-center will-change-transform"
                  data-home-parallax
                  data-parallax-direction="down"
                  style={homeMediaStyle("study")}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="mx-auto max-w-[1448px] px-4 pb-14 sm:px-6">
          <StarsCtaCard contentClassName="flex flex-col gap-5 p-7 text-white sm:flex-row sm:items-center sm:justify-between sm:p-9">
            <div>
              <span className="inline-flex items-center gap-2 text-xs font-bold text-white/80">
                <Users className="size-4" /> Your next hostel is just a search away
              </span>
              <h2 className="mt-2 font-heading text-2xl font-extrabold">
                Find your place with {identity.siteName}
              </h2>
              <p className="mt-2 max-w-2xl text-sm text-white/85">
                Compare verified hostels, then contact the one that feels right.
              </p>
            </div>
            <Link
              className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-white px-4 py-2.5 text-sm font-bold text-brand-teal transition hover:bg-white/90"
              href="/hostels"
            >
              Explore hostels <ArrowRight className="size-4" />
            </Link>
          </StarsCtaCard>
        </section>
      </div>
    </PublicShell>
  );
}

export function PublicHomePage({ hostels }: { hostels: HostelSummary[] }) {
  return (
    <Suspense fallback={null}>
      <PublicHomePageContent hostels={hostels} />
    </Suspense>
  );
}
