import { connectToDatabase } from "@/lib/db";
import { getSiteConfigSection } from "@/modules/platform-config/site-config.service";
import { HostelSubscriptionModel } from "@hostel/db/models/HostelSubscription";
import { getPlan } from "@hostel/shared/plans/catalog";
import {
  lifetimeOfferFor,
  lifetimeSeatsLeft,
  lifetimeWindow,
  type LifetimeWindow,
} from "@hostel/shared/plans/lifetime";

/**
 * The lifetime deal, as the server sells it: what is on offer today and how
 * many seats each tier has left.
 *
 * Deliberately free of `subscription.service` — that module prices a lifetime
 * plan through this one, so an import back would be a cycle.
 */

/**
 * Where a lifetime plan's period ends: the last instant of 31 December 2099 in
 * Kathmandu.
 *
 * A lifetime plan still writes `currentPeriodEnd`, because every rule that asks
 * "is this hostel paid up" — the renewal sweep, the due reminders, suspension,
 * the platform's live count — already reads it, and a date far enough out
 * answers all of them correctly without one of them learning a new state.
 * Screens never print it: they read `lifetime` and say so.
 *
 * It is never pushed through the Bikram Sambat helpers, which stop at 2090 BS.
 */
export const LIFETIME_PERIOD_END = new Date("2099-12-31T18:14:59.999Z");

/** True when a stored period end is the lifetime sentinel (or past it). */
export function isLifetimePeriodEnd(end: Date | string | null | undefined) {
  if (!end) return false;

  return new Date(end).getTime() >= LIFETIME_PERIOD_END.getTime();
}

/** Paid lifetime seats per tier — a count, never a stored total. */
export async function soldLifetimeSeats(): Promise<Record<string, number>> {
  await connectToDatabase();

  const rows = await HostelSubscriptionModel.aggregate<{ _id: string | null; sold: number }>([
    { $match: { lifetimeSince: { $type: "date" } } },
    { $group: { _id: "$planId", sold: { $sum: 1 } } },
  ]);

  return Object.fromEntries(
    rows.filter((row) => row._id).map((row) => [row._id as string, row.sold]),
  );
}

export type LifetimeAvailability = {
  /** The last day it can be bought (`YYYY-MM-DD`), or blank for no end. */
  endsOn: string;
  offers: {
    left: number;
    /** The tier's ordinary monthly price, for the comparison on a card. */
    monthly: number;
    planId: string;
    planName: string;
    price: number;
    seats: number;
    sold: number;
  }[];
  startsOn: string;
  window: LifetimeWindow;
};

/**
 * Every priced offer whose tier still exists, with its seats counted. Read by
 * the public pricing page, the team form and the superadmin tab alike, so the
 * three can never show different numbers.
 */
export async function getLifetimeAvailability(now = new Date()): Promise<LifetimeAvailability> {
  const [deal, catalog, sold] = await Promise.all([
    getSiteConfigSection("lifetime"),
    getSiteConfigSection("plans"),
    soldLifetimeSeats(),
  ]);

  const offers = deal.offers.flatMap((offer) => {
    const plan = getPlan(catalog, offer.planId);

    if (!plan || !lifetimeOfferFor(deal, offer.planId)) return [];

    const taken = sold[offer.planId] ?? 0;

    return [
      {
        left: lifetimeSeatsLeft(offer, taken),
        monthly: plan.monthly,
        planId: plan.id,
        planName: plan.name,
        price: offer.price,
        seats: offer.seats,
        sold: taken,
      },
    ];
  });

  return {
    endsOn: deal.endsOn,
    offers,
    startsOn: deal.startsOn,
    window: lifetimeWindow(deal, now),
  };
}
