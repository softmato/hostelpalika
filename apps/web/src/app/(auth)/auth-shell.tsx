"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";

import { BrandMark } from "@/components/brand-mark";
import DriftWall from "@/components/react-bits/drift-wall";
import { useSiteConfig } from "@/components/site-config-provider";

type AuthShellProps = {
  children: ReactNode;
  /** Replaces the default "Don't have an account?" / "Already have an account?" line. */
  footer?: ReactNode;
  mode: "login" | "signup";
};

/**
 * The platform's own screens, drifting: the phone app and the resident, warden
 * and guardian portals, from `public/mockups`. Laid out five to a row because
 * `DriftWall` deals items to its columns in turn, so every column gets a mix of
 * app and portal.
 */
const WALL_ITEMS = [
  "app-public-facing",
  "resident-portal",
  "warden-dashboard",
  "app-public-map-screen",
  "guardian-portal",
  "warden-room-management",
  "app-public-community-hostelviewpage",
  "resident-portal-feepayment",
  "warden-dashboard-finance",
  "app-public-map-android-screen",
  "resident-register-whole-process",
  "warden-paymentsetup-statement",
  "resident-portal-profile",
  "warden-dashboard-transaction",
  "resident-register-process-step-2",
].map((name) => ({ image: `/mockups/${name}.webp` }));

/**
 * Wordmark for the owner-configured site name. The first word stays ink and the
 * remainder picks up the brand green, which reproduces the original
 * "Hostel/Hub" lockup for any two-part name and degrades to plain ink for a
 * single word.
 */
function SiteWordmark() {
  const siteName = useSiteConfig().identity.siteName;
  const [head, ...rest] = siteName.split(" ");

  return (
    <Link className="flex items-center gap-2 transition hover:opacity-80" href="/">
      <BrandMark className="h-[22px]" />
      <span className="font-heading text-[19px] font-extrabold tracking-tight text-[#0F172A]">
        {head}
        {rest.length ? <span className="text-[#0A8A4B]"> {rest.join(" ")}</span> : null}
      </span>
    </Link>
  );
}

/**
 * Two-column auth frame: the platform's own pictures drifting edge to edge down
 * the left (no copy over them), and a single narrow centred column on the right
 * that holds nothing but the form. The form column is deliberately the only
 * place with controls.
 */
export function AuthShell({ children, footer, mode }: AuthShellProps) {
  // The panel is hidden below `lg`, so the wall (and its animation loop) only
  // exists where it can be seen.
  const [showWall, setShowWall] = useState(false);
  useEffect(() => {
    const query = window.matchMedia("(min-width: 1024px)");
    const sync = () => setShowWall(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  const defaultFooter =
    mode === "login" ? (
      <>
        Don&apos;t have an account?{" "}
        <Link className="font-semibold text-[#0A8A4B] hover:underline" href="/signup">
          Sign up
        </Link>
      </>
    ) : (
      <>
        Already have an account?{" "}
        <Link className="font-semibold text-[#0A8A4B] hover:underline" href="/login">
          Log in
        </Link>
      </>
    );

  return (
    <main className="flex h-dvh w-full bg-white">
      {/* ────── LEFT: the drifting wall, edge to edge, no words ────── */}
      <section
        aria-hidden
        className="relative hidden w-[58%] shrink-0 overflow-hidden lg:block"
        style={{ background: "radial-gradient(120% 90% at 50% 40%, #20252b 0%, #101318 55%, #07080a 100%)" }}
      >
        {showWall ? (
          <DriftWall
            className="drift-wall--devices"
            columns={5}
            depth={40}
            dim={1}
            fade={0.3}
            gap={2}
            items={WALL_ITEMS}
            lift={50}
            parallax={0.8}
            perspective={1400}
            roll={7}
            speed={26}
            tilt={20}
            tileHeight={195}
            tileWidth={280}
            turn={18}
            variance={0.35}
          />
        ) : null}
      </section>

      {/* ────── RIGHT: the form, and only the form ────── */}
      <section className="flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-8 lg:px-10">
        <div className="flex justify-center">
          <SiteWordmark />
        </div>

        <div className="flex flex-1 items-center justify-center py-6 sm:py-10">
          <div className="w-full max-w-[400px]">{children}</div>
        </div>

        <div className="text-center text-[13px] text-slate-500">
          {footer ?? defaultFooter}
        </div>
      </section>
    </main>
  );
}
