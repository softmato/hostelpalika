import type { PublicListingTier } from "@/lib/listing-tier";
import { cn } from "@/lib/utils";

import { TIER_TONE } from "./listing-tier-tone";

/**
 * The Gold / Platinum pill on a hostel card or page. Painted by `TIER_TONE`, the
 * same classes the plan cards and the badge's own page use, on an opaque
 * surface so it stays readable over a photo. The `title` says what it is — a
 * plan placement — because a metal on a listing otherwise reads as a rating.
 */
export function ListingTierBadge({
  className,
  tier,
}: {
  className?: string;
  tier: Pick<PublicListingTier, "label" | "tone">;
}) {
  return (
    <span className={cn("inline-flex rounded-full bg-surface", className)}>
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold",
          TIER_TONE[tier.tone].badge,
        )}
        title={`${tier.label}: a paid plan placement, not a rating`}
      >
        {tier.label}
      </span>
    </span>
  );
}
