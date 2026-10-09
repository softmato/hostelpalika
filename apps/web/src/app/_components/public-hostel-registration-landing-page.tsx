"use client";

import { ArrowRight, ChevronRight, type LucideIcon } from "lucide-react";
import {
  AnimatePresence,
  animate,
  motion,
  useInView,
  useReducedMotion,
  useScroll,
  useTransform,
  type Easing,
  type Variants,
} from "framer-motion";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { preconnect } from "react-dom";

import { browserApi } from "@/lib/browser-api";
import { cn } from "@/lib/utils";
import {
  HostelStatusView,
  type OwnerApplication,
} from "@/app/_components/public-hostel-registration-page";
import { MOCKUPS, type Mockup } from "@/app/_components/portal-mockups";
import { RegisterHostelStart } from "@/app/_components/register-hostel-start";
import { PublicShell } from "@/app/_components/shared";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/animate-ui/components/animate/tooltip";
import { useSiteConfig } from "@/components/site-config-provider";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { contentIcon, resolveContentPage } from "@/lib/site-content";
import { useSessionStore } from "@/stores/session-store";

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 30 },
  visible: (i = 0) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.12, duration: 0.6, ease: "easeOut" as Easing },
  }),
};

const stagger = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.1 } },
};

type Feature = {
  bullets: string[];
  description: string;
  icon: LucideIcon;
  image: Mockup;
  title: string;
  tone: "teal" | "platform" | "admin" | "resident" | "guardian";
};

/** Every portal screen we have, in the order an owner meets them. */
const heroSlides: { image: Mockup; label: string }[] = [
  { image: MOCKUPS.wardenDashboard, label: "Hostel dashboard" },
  { image: MOCKUPS.wardenRooms, label: "Rooms & beds" },
  { image: MOCKUPS.residentRegister, label: "Resident registration" },
  { image: MOCKUPS.residentVerify, label: "Identity check" },
  { image: MOCKUPS.wardenFinance, label: "Fee schedule & reconcile" },
  { image: MOCKUPS.wardenTransactions, label: "Transactions" },
  { image: MOCKUPS.wardenPaymentSetup, label: "Payment setup" },
  { image: MOCKUPS.residentPortal, label: "Resident portal" },
  { image: MOCKUPS.residentFees, label: "Resident fees & payments" },
  { image: MOCKUPS.residentProfile, label: "Resident ID card" },
  { image: MOCKUPS.guardianPortal, label: "Guardian portal" },
  { image: MOCKUPS.appCommunity, label: "Your public hostel page" },
  { image: MOCKUPS.appMap, label: "Found on the map" },
];

const TRUSTED_HOSTELS = [
  {
    initials: "EL",
    name: "Education Light Hostel",
    tone: "from-amber-400 to-rose-500",
  },
  {
    initials: "GS",
    name: "Green Stay Hostel, Kathmandu",
    tone: "from-teal-500 to-emerald-700",
  },
  {
    initials: "HV",
    name: "Himalayan View Hostel, Pokhara",
    tone: "from-sky-500 to-indigo-700",
  },
  {
    initials: "NB",
    name: "New Baneshwor Boys Hostel",
    tone: "from-violet-500 to-fuchsia-700",
  },
] as const;

/**
 * Presentation only. The features' **titles and descriptions** live in the
 * site config under `content.registerHostel.sections`, because the app shows the
 * same list on its Register your hostel screen — see `contentSchema`. What stays
 * here is what cannot be stored: the tone token and the screen shown beside it.
 *
 * Indexed by position rather than by title, so an owner rewording "Central
 * Dashboard" does not silently drop its picture. A section added past the end in the
 * admin panel falls back to the first chrome entry rather than crashing.
 */
const featureChrome: { image: Mockup; tone: Feature["tone"] }[] = [
  { image: MOCKUPS.wardenDashboard, tone: "platform" },
  { image: MOCKUPS.wardenRooms, tone: "admin" },
  { image: MOCKUPS.residentRegister, tone: "resident" },
  { image: MOCKUPS.residentVerify, tone: "teal" },
  { image: MOCKUPS.wardenFinance, tone: "admin" },
  { image: MOCKUPS.wardenPaymentSetup, tone: "platform" },
  { image: MOCKUPS.wardenTransactions, tone: "teal" },
  { image: MOCKUPS.residentPortal, tone: "resident" },
  { image: MOCKUPS.residentFees, tone: "resident" },
  { image: MOCKUPS.residentProfile, tone: "admin" },
  { image: MOCKUPS.guardianPortal, tone: "guardian" },
  { image: MOCKUPS.appCommunity, tone: "platform" },
  { image: MOCKUPS.appMap, tone: "teal" },
  { image: MOCKUPS.appHome, tone: "platform" },
];

/**
 * Counts the number inside a stat up from zero the first time it scrolls into
 * view — "3×", "9 in 10", "1,240". Text with no number in it renders as is.
 */
function CountUp({ text }: { text: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const inView = useInView(ref, { margin: "-80px", once: true });
  const reduced = useReducedMotion();
  const match = /^(\D*)([\d,]+(?:\.\d+)?)(.*)$/.exec(text);
  const target = match ? Number(match[2].replace(/,/g, "")) : 0;
  const [shown, setShown] = useState(0);

  useEffect(() => {
    if (!inView || reduced || target === 0) return;
    const controls = animate(0, target, {
      duration: 1.4,
      ease: "easeOut",
      onUpdate: setShown,
    });
    return () => controls.stop();
  }, [inView, reduced, target]);

  if (!match) return <span ref={ref}>{text}</span>;

  const decimals = match[2].split(".")[1]?.length ?? 0;
  const value = reduced ? target : shown;

  return (
    <span ref={ref}>
      {match[1]}
      {value.toLocaleString("en-US", {
        maximumFractionDigits: decimals,
        minimumFractionDigits: decimals,
      })}
      {match[3]}
    </span>
  );
}

function TrustedHostels() {
  return (
    <TooltipProvider>
      <div className="mt-9 flex items-center gap-3" aria-label="Trusted hostels">
        <div className="flex -space-x-2">
          {TRUSTED_HOSTELS.map((hostel) => (
            <Tooltip key={hostel.name}>
              <TooltipTrigger asChild>
                <button
                  aria-label={hostel.name}
                  className={cn(
                    "flex size-10 items-center justify-center rounded-full border-2 border-background bg-gradient-to-br text-[10px] font-extrabold text-white shadow-sm transition-transform hover:z-10 hover:-translate-y-1 focus:z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-teal/50",
                    hostel.tone,
                  )}
                  type="button"
                >
                  {hostel.initials}
                </button>
              </TooltipTrigger>
              <TooltipContent className="bg-foreground text-background">
                {hostel.name}
              </TooltipContent>
            </Tooltip>
          ))}
        </div>
        <p className="text-sm font-medium leading-snug text-muted-foreground">
          Trusted by hostel owners
          <br className="sm:hidden" /> across Nepal
        </p>
      </div>
    </TooltipProvider>
  );
}

/** The signed-in owner's most recent hostel application, if they have one. */
async function fetchOwnerApplication(): Promise<OwnerApplication | null> {
  try {
    const data = await browserApi<{ applications: OwnerApplication[] }>(
      "/api/v1/public/hostel-applications/my-applications",
    );
    return data.applications[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * With a demo video configured (Website Config → Mobile App) this opens it in a
 * dialog. The `<video>` mounts only on open, so the page never downloads a byte
 * of it until asked; hovering warms the connection to the bucket. Without one
 * it scrolls to the screenshots.
 */
function WatchDemo({ className, url }: { className: string; url: string }) {
  const label = (
    <>
      <span className="flex size-5 items-center justify-center rounded-full bg-brand-teal/10 text-[9px] text-brand-teal">
        ▶
      </span>
      Watch Demo
    </>
  );

  if (!url) {
    return (
      <Link className={className} href="#hostel-product-tour">
        {label}
      </Link>
    );
  }

  return (
    <Dialog>
      <DialogTrigger className={className} onPointerEnter={() => preconnect(url)}>
        {label}
      </DialogTrigger>
      <DialogContent className="aspect-video bg-black p-0 sm:max-w-5xl [&_[data-slot=dialog-close]]:text-white">
        <DialogTitle className="sr-only">Product demo</DialogTitle>
        <video autoPlay className="size-full" controls playsInline preload="auto" src={url} />
      </DialogContent>
    </Dialog>
  );
}

export function PublicHostelRegistrationLandingPage() {
  const { apps, content, identity, platformStats } = useSiteConfig();
  const siteName = identity.siteName;
  const page = resolveContentPage(content.registerHostel, identity);
  const stats = page.highlights;
  const features: Feature[] = page.sections.map((section, index) => ({
    ...(featureChrome[index] ?? featureChrome[0]),
    // The first line is the sentence under the title; the rest are its bullets.
    bullets: section.body.slice(1),
    description: section.body[0] ?? "",
    icon: contentIcon(section.icon),
    title: section.title,
  }));
  const [currentSlide, setCurrentSlide] = useState(0);
  const [showBottomCta, setShowBottomCta] = useState(false);
  const featureRef = useRef<HTMLDivElement>(null);
  const { scrollY } = useScroll();
  const router = useRouter();

  // If the signed-in user has already submitted a hostel, this route shows their
  // application status instead of the marketing page.
  const [statusApp, setStatusApp] = useState<OwnerApplication | null>(null);
  // Read from the shared session cache the header already fills, so the lookup
  // below can wait until it is known whether anyone is signed in.
  const sessionResolved = useSessionStore((state) => state.status === "resolved");
  const sessionUser = useSessionStore((state) => state.user);

  const loadOwnerStatus = useCallback(async () => {
    setStatusApp(await fetchOwnerApplication());
  }, []);

  useEffect(() => {
    // Only ask for an anonymous visitor's application if there is an account to
    // ask about. `my-applications` 401s for a signed-out visitor, and a 401 that
    // no refresh token can rescue is exactly what `browserApi` reads as an
    // expired session — it sends the tab to /login. So merely opening the pitch
    // page bounced people to the sign-in screen. Signing in is a requirement of
    // the *form*, and `/register-hostel/form` guards itself; the page that
    // explains the product asks nothing of anyone.
    if (!sessionResolved || !sessionUser) {
      return;
    }

    let active = true;

    void fetchOwnerApplication().then((application) => {
      // The visitor may have navigated away while the request was in flight.
      if (active) setStatusApp(application);
    });

    return () => {
      active = false;
    };
  }, [sessionResolved, sessionUser]);

  const bottomCtaOpacity = useTransform(scrollY, [600, 900], [0, 1]);

  useEffect(() => {
    const slideInterval = setInterval(() => {
      setCurrentSlide((prev) => (prev + 1) % heroSlides.length);
    }, 5000);
    return () => clearInterval(slideInterval);
  }, []);

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => setShowBottomCta(entry.isIntersecting),
      { threshold: 0 },
    );
    const el = featureRef.current;
    if (el) observer.observe(el);
    return () => {
      if (el) observer.unobserve(el);
    };
  }, []);

  // `sessionUser` guards the render as well as the fetch, so signing out in the
  // header drops the status view instead of leaving a stale one on screen.
  if (statusApp && sessionUser) {
    return (
      <PublicShell active="register-hostel">
        <HostelStatusView
          application={statusApp}
          onRegisterAnother={() => router.push("/register-hostel/form")}
          onResubmitted={loadOwnerStatus}
        />
      </PublicShell>
    );
  }

  return (
    <PublicShell active="register-hostel">
      <div className="relative overflow-hidden -mt-16">
        <div className="pointer-events-none absolute inset-0 overflow-hidden opacity-35 dark:opacity-10">
          <div className="absolute -left-52 -top-52 size-[34rem] rounded-full bg-brand-teal/35 blur-3xl" />
          <div className="absolute right-[-12rem] top-8 size-[46rem] rounded-full border-[70px] border-brand-teal/10" />
          <div className="absolute right-[-7rem] top-24 size-[34rem] rounded-full bg-cyan-300/20 blur-3xl" />
        </div>

        {/* Hero */}
        <section className="relative mx-auto grid max-w-[1380px] gap-8 px-6 pb-14 pt-28 sm:px-8 md:px-10 md:pb-20 md:pt-36 lg:min-h-[700px] lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] lg:items-center lg:gap-10 lg:px-14 lg:py-20 xl:px-16">
          <motion.div
            className="relative z-10 max-w-xl lg:mx-0"
            initial="hidden"
            animate="visible"
            variants={stagger}
          >
            <motion.div
              className="mb-6 inline-flex items-center gap-2 rounded-full bg-brand-teal/10 px-4 py-2 text-xs font-bold text-brand-teal"
              variants={fadeUp}
              custom={0}
            >
              <span className="size-1.5 rounded-full bg-brand-teal" />
              Smart Hostel Management
            </motion.div>
            <motion.h1
              className="max-w-[620px] text-[2.35rem] font-bold leading-[1.08] tracking-[-0.035em] text-foreground sm:text-[3.4rem] md:text-[3.8rem] lg:text-[4rem]"
              variants={fadeUp}
              custom={1}
            >
              <span className="block">Become a Partner</span>
              <span className="mt-1 block bg-gradient-to-r from-brand-teal to-emerald-400 bg-clip-text text-transparent sm:mt-2">
                with {siteName}
              </span>
            </motion.h1>
            <motion.p
              className="mt-6 max-w-[34rem] text-base leading-relaxed text-muted-foreground md:text-lg"
              variants={fadeUp}
              custom={2}
            >
              The all-in-one hostel management app designed to make your daily operations
              simpler, smarter and more efficient.
            </motion.p>

            {/* The calls to action copy the compact reference treatment. */}
            <motion.div
              className="mt-8 flex flex-col items-stretch gap-3 sm:flex-row sm:items-center"
              variants={fadeUp}
              custom={3}
            >
              <RegisterHostelStart
                className="inline-flex h-13 items-center justify-center gap-2 rounded-full bg-brand-teal px-7 text-sm font-bold text-white shadow-lg shadow-brand-teal/25 transition hover:brightness-110 md:h-14 md:text-base md:px-8"
              >
                Get Started Free
                <ArrowRight className="size-4" />
              </RegisterHostelStart>
              <WatchDemo
                className="inline-flex h-13 items-center justify-center gap-2 rounded-full border border-border bg-background/75 px-7 text-sm font-semibold text-foreground shadow-sm transition hover:bg-muted md:h-14 md:text-base md:px-8"
                url={apps.demoVideoUrl}
              />
            </motion.div>

            <motion.div variants={fadeUp} custom={4}>
              <TrustedHostels />
            </motion.div>
          </motion.div>

          {/* An unframed, automatically changing product view. */}
          <motion.div
            className="relative mx-auto w-full max-w-3xl lg:mr-0"
            initial={{ opacity: 0, x: 24, scale: 0.97 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            transition={{ delay: 0.6, duration: 0.8 }}
            id="hostel-product-tour"
          >
            <div className="pointer-events-none absolute inset-x-12 bottom-6 top-10 rounded-[50%] bg-brand-teal/10 blur-3xl" />
            <div className="relative h-[22rem] sm:h-[29rem] lg:h-[34rem]">
              <AnimatePresence initial={false} mode="wait">
                <motion.div
                  className="absolute inset-0"
                  key={heroSlides[currentSlide].image.src}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.35, ease: "easeInOut" }}
                >
                  <Image
                    alt={heroSlides[currentSlide].image.alt}
                    className="object-contain"
                    fill
                    priority={currentSlide === 0}
                    sizes="(min-width: 1024px) 700px, 100vw"
                    src={heroSlides[currentSlide].image.src}
                  />
                </motion.div>
              </AnimatePresence>
            </div>
            <div className="sr-only" aria-live="polite">
              Showing {heroSlides[currentSlide].label}
            </div>
          </motion.div>
        </section>

        {/* Stats: real counts first, then the growth claims an owner is sold on */}
        {platformStats.length > 0 || stats.length > 0 ? (
          <section className="relative z-10 -mt-10 overflow-hidden bg-muted/30 md:-mt-16">
            <div className="pointer-events-none absolute -left-24 top-1/2 size-72 -translate-y-1/2 rounded-full bg-brand-teal/10 blur-3xl" />
            <div className="relative mx-auto max-w-[1200px] px-6 pb-14 pt-10 md:pb-20 md:pt-14">
              {platformStats.length > 0 ? (
                <div className={cn(stats.length > 0 && "mb-14")}>
                  <p className="flex items-center justify-center gap-2 text-xs font-bold uppercase tracking-[0.18em] text-brand-teal">
                    <span className="relative flex size-2">
                      <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-teal opacity-60" />
                      <span className="relative inline-flex size-2 rounded-full bg-brand-teal" />
                    </span>
                    Live on {siteName}
                  </p>
                  <div className="mt-6 grid gap-6 sm:grid-cols-3">
                    {platformStats.map((stat) => (
                      <div className="text-center" key={stat.label}>
                        <p className="text-3xl font-extrabold text-foreground sm:text-4xl md:text-5xl">
                          <CountUp text={stat.value.toLocaleString("en-US")} />
                        </p>
                        <p className="mt-1 text-xs font-semibold text-muted-foreground md:text-sm">
                          {stat.label}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {stats.length > 0 ? (
                <>
                  <h2 className="text-center text-2xl font-bold text-foreground md:text-3xl">
                    Get your hostel more popular
                  </h2>
                  <p className="mx-auto mt-2 max-w-xl text-center text-sm text-muted-foreground md:text-base">
                    What changes when students can find you and residents pay from their
                    phone.
                  </p>
                  <motion.div
                    className="mt-8 grid grid-cols-2 gap-4 md:grid-cols-4"
                    initial="hidden"
                    whileInView="visible"
                    viewport={{ once: true, margin: "-80px" }}
                    variants={stagger}
                  >
                    {stats.map((stat, index) => (
                      <motion.div
                        className="group relative overflow-hidden rounded-2xl border border-border bg-background p-5 shadow-sm transition hover:-translate-y-1 hover:border-brand-teal/40 hover:shadow-lg"
                        custom={index}
                        key={stat.label}
                        variants={fadeUp}
                      >
                        <span className="absolute -right-8 -top-8 size-24 rounded-full bg-brand-teal/10 transition duration-500 group-hover:scale-150" />
                        <p className="relative font-heading text-3xl font-extrabold text-brand-teal sm:text-4xl md:text-5xl">
                          <CountUp text={stat.value} />
                        </p>
                        <p className="relative mt-2 text-sm font-semibold leading-snug text-foreground">
                          {stat.label}
                        </p>
                      </motion.div>
                    ))}
                  </motion.div>
                </>
              ) : null}
            </div>
          </section>
        ) : null}

        {/* Features with scroll-triggered images */}
        <section
          ref={featureRef}
          className="mx-auto max-w-[1200px] px-5 py-16 sm:px-6 md:py-28"
        >
          <motion.div
            className="mb-14 text-center"
            initial="hidden"
            whileInView="visible"
            viewport={{ once: true, margin: "-80px" }}
            variants={stagger}
          >
            <motion.h2
              className="text-3xl font-bold text-foreground md:text-4xl"
              variants={fadeUp}
            >
              Everything you need to run your hostel
            </motion.h2>
            <motion.p
              className="mx-auto mt-4 max-w-xl text-sm text-muted-foreground md:text-base"
              variants={fadeUp}
              custom={1}
            >
              A fully integrated platform for hostel owners, staff, residents, and
              guardians.
            </motion.p>
          </motion.div>

          <div className="space-y-14 md:space-y-28">
            {features.map((feature, idx) => {
              const isEven = idx % 2 === 0;

              return (
                <motion.div
                  key={feature.title}
                  className={`flex flex-col items-center gap-6 md:gap-8 md:flex-row ${isEven ? "" : "md:flex-row-reverse"}`}
                  initial="hidden"
                  whileInView="visible"
                  viewport={{ once: true, margin: "-120px" }}
                  variants={stagger}
                >
                  {/* Text side */}
                  <motion.div className="flex-1 space-y-4" variants={fadeUp}>
                    <span
                      className={cn(
                        "mb-3 inline-flex size-10 items-center justify-center rounded-xl",
                        feature.tone === "teal" && "bg-brand-teal/10 text-brand-teal",
                        feature.tone === "platform" &&
                          "bg-role-platform-soft text-role-platform",
                        feature.tone === "admin" && "bg-role-admin-soft text-role-admin",
                        feature.tone === "resident" &&
                          "bg-role-resident-soft text-role-resident",
                        feature.tone === "guardian" &&
                          "bg-role-guardian-soft text-role-guardian",
                      )}
                    >
                      <feature.icon className="size-5" />
                    </span>
                    <h3 className="text-2xl font-bold text-foreground">
                      {feature.title}
                    </h3>
                    <p className="text-base leading-relaxed text-muted-foreground">
                      {feature.description}
                    </p>
                    {feature.bullets.length > 0 ? (
                      <ul className="space-y-2 pt-2">
                        {feature.bullets.map((bullet) => (
                          <li
                            className="flex items-start gap-3 text-sm text-muted-foreground"
                            key={bullet}
                          >
                            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-brand-teal/10 text-[10px] font-bold text-brand-teal">
                              &#10003;
                            </span>
                            {bullet}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </motion.div>

                  {/* Keeping the product view static avoids an off-screen image
                      remaining transparent on smaller devices. */}
                  <div className="w-full flex-1">
                    <div className="relative h-60 w-full overflow-hidden rounded-3xl border border-border/70 bg-background/70 p-2 shadow-sm sm:h-80 md:h-96 md:rounded-none md:border-0 md:bg-transparent md:p-0 md:shadow-none">
                      <Image
                        alt={feature.image.alt}
                        className="object-contain p-2 md:p-0"
                        fill
                        sizes="(min-width: 768px) 576px, calc(100vw - 2.5rem)"
                        src={feature.image.src}
                      />
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </div>
        </section>

        {/* Bottom CTA */}
        <section className="border-t border-border bg-gradient-to-b from-background to-muted/20">
          <div className="mx-auto max-w-[1200px] px-6 py-20 md:py-28">
            <motion.div
              className="mx-auto max-w-2xl text-center"
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-80px" }}
              variants={stagger}
            >
              <motion.h2
                className="text-3xl font-bold text-foreground md:text-4xl"
                variants={fadeUp}
              >
                Ready to bring your hostel online?
              </motion.h2>
              <motion.p
                className="mx-auto mt-4 max-w-lg text-sm text-muted-foreground md:text-base"
                variants={fadeUp}
                custom={1}
              >
                List your property, manage residents, and give everyone their own portal —
                all from one place.
              </motion.p>
              <motion.div
                className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row"
                variants={fadeUp}
                custom={2}
              >
                <RegisterHostelStart
                  className="inline-flex h-13 items-center gap-2 rounded-xl bg-brand-teal px-7 text-sm font-bold text-white shadow-lg shadow-brand-teal/25 transition hover:brightness-110 md:h-14 md:text-base md:px-8"
                >
                  Register Your Hostel
                  <ArrowRight className="size-4" />
                </RegisterHostelStart>
                <Link
                  href="/service-providers"
                  className="inline-flex h-13 items-center gap-1 rounded-xl border border-border px-7 text-sm font-semibold text-foreground transition hover:bg-muted md:h-14 md:text-base md:px-8"
                >
                  Register as Service Provider
                  <ChevronRight className="size-4" />
                </Link>
              </motion.div>
            </motion.div>
          </div>
        </section>
      </div>

      {/* Floating bottom register button - appears on scroll */}
      <motion.div
        className="fixed bottom-6 left-1/2 z-40 -translate-x-1/2 md:bottom-8"
        style={{
          opacity: bottomCtaOpacity,
          pointerEvents: showBottomCta ? "auto" : ("none" as const),
        }}
      >
        <RegisterHostelStart
          className="inline-flex h-12 items-center gap-2 rounded-2xl bg-brand-teal px-6 text-sm font-bold text-white shadow-xl shadow-brand-teal/30 transition hover:brightness-110 md:h-14 md:px-8 md:text-base"
        >
          Register Your Hostel Now
          <ArrowRight className="size-4" />
        </RegisterHostelStart>
      </motion.div>
    </PublicShell>
  );
}
