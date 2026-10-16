"use client";

import { Info, X } from "@/components/icons";
import Link from "next/link";
import { useState } from "react";

import { useSiteConfig } from "@/components/site-config-provider";
import { cn } from "@/lib/utils";

const toneClasses = {
  info: "bg-brand-teal text-white",
  success: "bg-emerald-600 text-white",
  warning: "bg-amber-500 text-white",
} as const;

/**
 * Site-wide banner controlled from Platform → Website Config → Announcements.
 * Renders nothing unless the owner has both enabled it and written a message.
 */
export function SiteAnnouncementBanner() {
  const { announcement } = useSiteConfig();
  const [dismissed, setDismissed] = useState(false);

  if (!announcement.enabled || !announcement.message || dismissed) {
    return null;
  }

  return (
    <div
      className={cn(
        "relative z-50 px-4 py-2 text-center text-[13px] font-medium",
        toneClasses[announcement.tone],
      )}
    >
      <div className="mx-auto flex max-w-[1448px] items-center justify-center gap-2">
        <Info className="size-3.5 shrink-0" />
        <span>{announcement.message}</span>
        {announcement.link && announcement.linkLabel ? (
          <Link
            className="shrink-0 underline underline-offset-2 hover:opacity-80"
            href={announcement.link}
          >
            {announcement.linkLabel}
          </Link>
        ) : null}
      </div>
      <button
        aria-label="Dismiss announcement"
        className="absolute right-3 top-1/2 -translate-y-1/2 rounded p-1 transition hover:bg-white/20"
        onClick={() => setDismissed(true)}
        type="button"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}
