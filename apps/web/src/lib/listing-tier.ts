/**
 * The directory badge a hostel's plan carries — Gold on Max, Platinum on Pro in
 * the shipped catalogue — and the order it buys in the public listing.
 *
 * The badge is derived, never stored on the hostel: it is whatever the plan the
 * hostel is paying for says today (Website Config → Plans), so a lapsed or
 * downgraded plan loses its place on the next read with nothing to clean up.
 *
 * `rank` is the plan's position in the catalogue, counted from one, so a plan
 * further up the ladder sorts first and a hostel with no badge sorts as 0.
 * The rank orders the default ("Recommended") listing only. A visitor who asks
 * for cheapest-first, top-rated or nearest gets exactly that; the badge then
 * only breaks ties. It is a paid placement and every page that shows it says so.
 */

import { PLATFORM_NAME } from "@hostel/shared/brand/brand";

export type ListingTierTone = "gold" | "platinum";

export type PublicListingTier = {
  label: string;
  rank: number;
  slug: string;
  tone: ListingTierTone;
};

type CatalogLike = {
  plans: Array<{
    id: string;
    listingTier: { label: string; slug: string; tone: ListingTierTone } | null;
  }>;
};

/** Plan id → the badge it carries. Plans without one are absent. */
export function listingTiersByPlan(catalog: CatalogLike) {
  const tiers = new Map<string, PublicListingTier>();

  catalog.plans.forEach((plan, index) => {
    if (plan.listingTier) {
      tiers.set(plan.id, {
        label: plan.listingTier.label,
        rank: index + 1,
        slug: plan.listingTier.slug,
        tone: plan.listingTier.tone,
      });
    }
  });

  return tiers;
}

export function listingTierRank(tier: Pick<PublicListingTier, "rank"> | null | undefined) {
  return tier?.rank ?? 0;
}

/** Higher badge first; `0` when both carry the same (or none). Stable-sort friendly. */
export function compareListingTier(
  a: { listingTier?: Pick<PublicListingTier, "rank"> | null },
  b: { listingTier?: Pick<PublicListingTier, "rank"> | null },
) {
  return listingTierRank(b.listingTier) - listingTierRank(a.listingTier);
}

/** The one sentence every page that orders by badge carries. */
export const PAID_PLACEMENT_NOTE = `Gold and Platinum hostels are on paid ${PLATFORM_NAME} plans and are shown first. The badge is a placement, not a rating — compare rent, rooms and reviews before you choose.`;
