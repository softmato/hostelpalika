"use client";

import Image from "next/image";
import Link from "next/link";

import { PLATFORM_NAME, PLATFORM_VENDOR, PLATFORM_VENDOR_URL } from "@hostel/shared/brand/brand";

import { BrandMark } from "@/components/brand-mark";
import { GooglePlayBadge } from "@/components/google-play-badge";
import { useSiteConfig } from "@/components/site-config-provider";
import { locationSlug } from "@/lib/hostel-locations";

/**
 * The footer every public page shares.
 *
 * It used to live inside the home page alone, so no other page linked anywhere
 * but its own header. For people that was a dead end at the bottom of a page;
 * for search engines it meant the city pages, the software page and the
 * comparisons were reachable only from the sitemap. Every group here is a set
 * of real destinations, and each follows the owner's feature flags — a surface
 * switched off in Website Config is not advertised down here.
 */

const CITY_LINKS = 6;

export function PublicFooter() {
  const { features, identity, locations, seo, social } = useSiteConfig();

  const socialLinks = (
    [
      ["Facebook", social.facebook],
      ["Instagram", social.instagram],
      ["YouTube", social.youtube],
      ["TikTok", social.tiktok],
      ["LinkedIn", social.linkedin],
      ["Website", social.website],
    ] satisfies Array<[string, string]>
  ).filter(([, href]) => Boolean(href));

  const groups: Array<{ links: Array<[string, string]>; title: string }> = [
    {
      links: [
        ["Browse hostels in Nepal", "/hostels"],
        ...locations
          .slice(0, CITY_LINKS)
          .map((location): [string, string] => [
            `Hostels in ${location.city}`,
            `/hostels/in/${locationSlug(location.city)}`,
          ]),
        ["All cities", "/hostels/in"],
        ["Hostel map", "/map"],
        ...(features.compare ? [["Compare hostels", "/compare"] as [string, string]] : []),
      ],
      title: "Find a hostel",
    },
    {
      links: [
        ["Hostel management system", "/hostel-management-software"],
        ["Features", "/features"],
        ["Plans & pricing", "/plans-pricing"],
        ["Pay for your hostel", "/plans-pricing/checkout"],
        ...(features.publicRegistration
          ? [["List your hostel", "/register-hostel"] as [string, string]]
          : []),
        ...seo.comparisons.map((comparison): [string, string] => [
          `${PLATFORM_NAME} vs ${comparison.name}`,
          `/vs/${comparison.slug}`,
        ]),
      ],
      title: "For hostel owners",
    },
    {
      links: [
        ["About us", "/about"],
        ["Contact", "/contact"],
        ["Community", "/community"],
        ...(features.serviceProviderSignup
          ? [["Service providers", "/service-providers"] as [string, string]]
          : []),
        ["Log in", "/login"],
      ],
      title: "Company",
    },
  ];

  return (
    <footer className="border-t border-border bg-surface">
      <div className="mx-auto grid max-w-[1448px] gap-10 px-6 py-12 lg:grid-cols-[1.1fr_2.4fr]">
        <div>
          <Link aria-label={PLATFORM_NAME} className="inline-flex items-center" href="/">
            <BrandMark adaptive className="h-10" />
          </Link>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted-foreground">
            {identity.tagline ||
              "Hostels in Nepal, and the hostel management system that runs them."}
          </p>

          <div className="mt-5 space-y-2 text-sm font-medium text-muted-foreground">
            {identity.supportPhone ? (
              <a
                className="block transition hover:text-primary"
                href={`tel:${identity.supportPhone.replace(/\s/g, "")}`}
              >
                {identity.supportPhone}
              </a>
            ) : null}
            {identity.supportEmail ? (
              <a
                className="block transition hover:text-primary"
                href={`mailto:${identity.supportEmail}`}
              >
                {identity.supportEmail}
              </a>
            ) : null}
            {identity.address ? <p>{identity.address}</p> : null}
          </div>

          {socialLinks.length > 0 ? (
            <div className="mt-5 flex flex-wrap gap-3 text-sm font-semibold text-muted-foreground">
              {socialLinks.map(([label, href]) => (
                <a
                  className="transition hover:text-primary"
                  href={href}
                  key={label}
                  rel="noreferrer noopener"
                  target="_blank"
                >
                  {label}
                </a>
              ))}
            </div>
          ) : null}

          <GooglePlayBadge className="-ml-2.5 mt-4 block w-fit" />

          <a
            className="mt-6 inline-flex items-center gap-3 rounded-xl border border-border bg-white px-3.5 py-2 text-xs font-semibold text-neutral-600 transition hover:border-primary/50"
            href={PLATFORM_VENDOR_URL}
            rel="noopener"
            target="_blank"
          >
            A product of
            <Image
              alt={PLATFORM_VENDOR}
              className="h-9 w-auto"
              height={776}
              src="/brand/softmato.png"
              width={1032}
            />
          </a>
        </div>

        <nav aria-label="Footer" className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          {groups.map((group) => (
            <div key={group.title}>
              <p className="text-sm font-extrabold text-foreground">{group.title}</p>
              <ul className="mt-4 space-y-3">
                {group.links.map(([label, href]) => (
                  <li key={href}>
                    <Link
                      className="text-sm font-medium text-muted-foreground transition hover:text-primary"
                      href={href}
                    >
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>

      <div className="border-t border-border">
        <div className="mx-auto flex max-w-[1448px] flex-col gap-3 px-6 py-5 text-xs font-medium text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <p>
            © {new Date().getFullYear()} {PLATFORM_NAME} · A product of{" "}
            <a
              className="font-semibold hover:text-primary"
              href={PLATFORM_VENDOR_URL}
              rel="noopener"
              target="_blank"
            >
              {PLATFORM_VENDOR}
            </a>
          </p>
          <div className="flex gap-4">
            <Link className="hover:text-primary" href="/privacy">
              Privacy
            </Link>
            <Link className="hover:text-primary" href="/terms">
              Terms
            </Link>
            <Link className="hover:text-primary" href="/refund-policy">
              Refunds
            </Link>
            <Link className="hover:text-primary" href="/how-booking-works">
              Booking
            </Link>
          </div>
        </div>
      </div>
    </footer>
  );
}
