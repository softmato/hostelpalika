"use client";

import { ImagePlus, X } from "@/components/icons";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

import { browserApi } from "@/lib/browser-api";
import { hasNoHostelPhotos, type HostelPhoto } from "@/lib/hostel-photos";

const DISMISS_KEY = "hostel-photo-reminder-dismissed";

/**
 * A hostel with no photos at all shows the stock image everywhere — on its
 * listing card, its public page and every room type. That is worth nagging
 * about, so this rides above every admin screen until the first photo lands
 * (or the admin dismisses it for the session).
 */
export function HostelPhotoReminder({ profileHref }: { profileHref: string }) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (sessionStorage.getItem(DISMISS_KEY) === "1") {
      return;
    }

    let cancelled = false;

    // Never let the reminder delay the screen the admin actually opened.
    const timer = window.setTimeout(() => {
      void browserApi<{ hostel: { photos?: HostelPhoto[] } }>(
        "/api/v1/hostel-admin/profile",
      )
        .then((data) => {
          if (!cancelled && hasNoHostelPhotos(data.hostel.photos)) {
            setVisible(true);
          }
        })
        .catch(() => {
          // A reminder is not worth surfacing an error for.
        });
    }, 600);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const dismiss = useCallback(() => {
    sessionStorage.setItem(DISMISS_KEY, "1");
    setVisible(false);
  }, []);

  if (!visible) {
    return null;
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-role-admin/20 bg-role-admin-soft px-4 py-2.5 text-sm text-role-admin">
      <ImagePlus className="size-4 shrink-0" />
      <p className="min-w-0 flex-1">
        Your hostel has no photos yet — please upload at least the exterior and interior
        photos so your listing and room types stop showing a stock image.
      </p>
      <Link
        className="shrink-0 rounded-md bg-role-admin px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-role-admin/85"
        href={profileHref}
      >
        Upload photos
      </Link>
      <button
        aria-label="Dismiss"
        className="shrink-0 rounded-md p-1 transition hover:bg-role-admin/10"
        onClick={dismiss}
        type="button"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
