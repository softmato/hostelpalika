"use client";

import { useSiteConfig } from "@/components/site-config-provider";
import { cn } from "@/lib/utils";

/** Google's own badge artwork, hotlinked as their badge generator hands it out. */
const BADGE_SRC =
  "https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png";

/**
 * "Get it on Google Play", pointing at the listing set in Website Config →
 * Mobile App. Renders nothing when that link is blank. The PNG carries its own
 * transparent margin, which is why it is sized larger than it looks.
 */
export function GooglePlayBadge({ className }: { className?: string }) {
  const { apps } = useSiteConfig();

  if (!apps.androidPlayUrl) {
    return null;
  }

  return (
    <a
      className={cn("inline-block", className)}
      href={apps.androidPlayUrl}
      rel="noopener"
      target="_blank"
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- Google's hosted badge, not ours to optimise */}
      <img alt="Get it on Google Play" className="h-[60px] w-auto" height={250} src={BADGE_SRC} width={646} />
    </a>
  );
}
