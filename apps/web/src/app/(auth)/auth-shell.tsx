"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { BrandMark } from "@/components/brand-mark";
import { useSiteConfig } from "@/components/site-config-provider";
import { optimizedImage } from "@/lib/image-url";

type AuthShellProps = {
  children: ReactNode;
  /** Replaces the default "Don't have an account?" / "Already have an account?" line. */
  footer?: ReactNode;
  mode: "login" | "signup";
};

const LOBBY_IMAGE =
  "https://lh3.googleusercontent.com/aida-public/AB6AXuAD0NmbtkszFG87IhrLCwa2eHWDmk4NxOgpfoid2_zjZOx8uWA_hMcSeKmVOMRSjh6cGCyLc1Z9nGlZcL0Ki792qNxyaYBty13f2J3WQOuXIX_srJKrKQdS6r3NM_RDpDB3vErb3M4AXliIEEDa0efsPzIkws2iSLR5sBqDWjn4m6sUtt9ldLyN6Qa-ajl1zvazFY7UZ_2dAjeEU277a2C041A_ZzYl0_2dfHrJqKF0tb0-ivW1NlN_H88HwOtS1kTCG90Xs6WE0dc";

const PANEL_COPY = {
  login: {
    body: "Rooms, residents, dues and daily attendance in one place — from the front desk or from your phone.",
    headline: ["Everything", "Under", "One Roof"],
  },
  signup: {
    body: "Discover verified hostels, compare facilities and prices, and book the room that fits you.",
    headline: ["Find The", "Room That", "Fits You"],
  },
} as const;

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
 * Two-column auth frame: a full-bleed photo panel on the left carrying the
 * tagline and one line of copy, and a single narrow centred column on the right
 * that holds nothing but the form. The form column is deliberately the only
 * place with controls — feature bullets and trust badges used to sit beside the
 * fields and pulled the eye away from the one thing the page is for.
 */
export function AuthShell({ children, footer, mode }: AuthShellProps) {
  const identity = useSiteConfig().identity;
  const panel = PANEL_COPY[mode];

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
    <main className="flex h-dvh w-full bg-white p-0 lg:p-3">
      {/* ────── LEFT: photo panel ────── */}
      <section className="relative hidden w-[46%] max-w-[660px] shrink-0 overflow-hidden rounded-3xl bg-[#04140C] lg:flex lg:flex-col lg:justify-between">
        <div
          aria-hidden
          className="absolute inset-0 bg-cover bg-center"
          style={{ backgroundImage: `url("${optimizedImage(LOBBY_IMAGE, 1200)}")` }}
        />
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(180deg, rgba(4,20,12,0.55) 0%, rgba(4,20,12,0.30) 38%, rgba(4,20,12,0.92) 100%)",
          }}
        />
        <div
          aria-hidden
          className="absolute inset-0"
          style={{
            background:
              "linear-gradient(200deg, rgba(10,138,75,0.42) 0%, transparent 55%)",
          }}
        />

        {/* Tagline, ruled like a chapter mark */}
        <div className="relative z-10 flex items-center gap-4 px-10 pt-10">
          <span className="text-[11px] font-semibold uppercase tracking-[0.22em] text-white/75">
            {identity.tagline || identity.siteName}
          </span>
          <span className="h-px flex-1 bg-white/25" />
        </div>

        <div className="relative z-10 px-10 pb-12">
          <h2 className="font-heading text-[46px] font-extrabold leading-[1.06] tracking-tight text-white xl:text-[54px]">
            {panel.headline.map((line) => (
              <span className="block" key={line}>
                {line}
              </span>
            ))}
          </h2>
          <p className="mt-5 max-w-[400px] text-[13px] leading-relaxed text-white/70">
            {panel.body}
          </p>
        </div>
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
