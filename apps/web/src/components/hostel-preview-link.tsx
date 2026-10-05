"use client";

import { ExternalLink } from "lucide-react";

import type { Hostel } from "@/app/_components/core-portal-shared";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";

/**
 * "Preview public page" in the hostel admin header.
 *
 * Mounted only on the admin portal, so the profile request it shares with the
 * Profile / Rooms / Fee Plans screens never fires on the other portals. The
 * public route serves published + verified hostels only — anything else would
 * 404 the admin, so the button simply stays hidden until the listing is live.
 */
export function HostelPreviewLink({
  className,
  menu = false,
  onNavigate,
}: {
  className?: string;
  menu?: boolean;
  onNavigate?: () => void;
}) {
  const profileResource = usePortalResource<{ hostel: Hostel }>(
    hostelAdminEndpoints.profile,
    { errorMessage: "" },
  );

  const hostel = profileResource.data?.hostel;
  const isLive =
    hostel?.status === "PUBLISHED" &&
    hostel.verificationStatus === "VERIFIED" &&
    Boolean(hostel.slug);

  if (!isLive) {
    return null;
  }

  return (
    <a
      className={cn(
        menu
          ? "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-foreground transition hover:bg-muted"
          : "inline-flex h-8 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-[11px] font-semibold text-slate-600 shadow-sm transition hover:text-foreground dark:border-border dark:bg-card dark:text-foreground",
        className,
      )}
      href={`/hostels/${hostel?.slug}`}
      onClick={onNavigate}
      rel="noreferrer"
      target="_blank"
      title="Open this hostel's public listing in a new tab"
    >
      <ExternalLink className="size-3.5" />
      Preview public page
    </a>
  );
}
