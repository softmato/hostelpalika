import { Types } from "mongoose";

import { logger } from "@/lib/logger";
import type { FeeScheduleRecord } from "@/modules/finance/fee-schedule.service";
import { HostelModel } from "@hostel/db/models/Hostel";

/**
 * The public listing, written from the rate card.
 *
 * ## The bug this exists to end
 *
 * A price was stored in three places a human could type into:
 *
 *   - `FeeSchedule.rates[].monthlyAmount` — what billing invoices
 *   - `Hostel.roomConfigurations[].monthlyRent` — what the public page shows
 *   - `Hostel.pricing.monthlyRentMin/Max` — what search filters and cards show
 *
 * and nothing compared them. The rate-card editor prefills from the *previous
 * rate card*; it has never shown the listing price beside the box. So one hostel
 * advertised a single room at 18,000, had 180,000 on its card, and invoiced a
 * resident 174,000 for their first month. Every screen involved was reading its
 * own number correctly.
 *
 * The split was deliberate once — listing price as marketing, rate card as
 * contract — and it did not survive contact with a hostel. There is one price.
 * The rate card holds it, and everything a member of the public sees is written
 * from here.
 *
 * ## Projection, not synchronisation
 *
 * One direction only. The card is written by a person; the listing is written by
 * this function and by nothing else (`updateHostelAdminProfile` now refuses those
 * fields once a card exists). Two-way sync between two stores is the thing that
 * drifts — this leaves one store and one derived view, which is the same shape
 * `capacitySummary` and `InvoiceBalance` already use.
 *
 * ## Never fatal
 *
 * The rate card is saved by the time this runs and it is the record that
 * matters. A listing that could not be refreshed is a log line and a stale
 * public page, not a rate change the owner is told failed after it succeeded.
 */

type RoomConfiguration = {
  monthlyRent?: number | null;
  roomType?: string | null;
};

type ListingHostel = {
  pricing?: { admissionFee?: number; formFee?: number; currency?: string };
  roomConfigurations?: RoomConfiguration[];
};

/** Case- and punctuation-insensitive, matching `rateForRoomType`. */
function key(value: string | null | undefined) {
  return (value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type ListingProjection = {
  admissionFee?: number; formFee?: number;
  monthlyRentMax?: number;
  monthlyRentMin?: number;
  roomConfigurations: RoomConfiguration[];
  /** Room types the card prices but the hostel does not list, and vice versa. */
  unmatched: { onCardOnly: string[]; onListingOnly: string[] };
};

/**
 * The listing this rate card implies, as arithmetic.
 *
 * Split from the write so the rules are testable without a database, and so the
 * rate-card screen can show an owner what their public page is about to say
 * before they save it — which is the check that would have caught the 180,000.
 *
 * A room type the card does not price keeps whatever rent it had. Blanking it
 * would take a hostel's advertised price off its own listing because finance has
 * not got round to that room type yet, and an out-of-date price is less harmful
 * than no price on a page people search by.
 */
export function projectSchedule(
  hostel: ListingHostel | null,
  schedule: Pick<FeeScheduleRecord, "admissionFee" | "formFee" | "rates">,
): ListingProjection {
  const configurations = hostel?.roomConfigurations ?? [];
  const rateByKey = new Map<string, number>();

  for (const rate of schedule.rates) {
    if (rate.roomType) {
      rateByKey.set(key(rate.roomType), rate.monthlyAmount);
    }
  }

  const matched = new Set<string>();

  const roomConfigurations = configurations.map((configuration) => {
    const rate = rateByKey.get(key(configuration.roomType));

    if (rate === undefined) {
      return configuration;
    }

    matched.add(key(configuration.roomType));

    return { ...configuration, monthlyRent: rate };
  });

  /*
   * The range is computed from the projected rents rather than from the card's
   * rates, so a room type the card does not price still counts toward what the
   * hostel advertises. A listing that says "from 12,000" while its own page
   * shows a 10,000 room is the same class of disagreement in miniature.
   */
  const rents = roomConfigurations
    .map((configuration) => configuration.monthlyRent)
    .filter((rent): rent is number => typeof rent === "number" && rent > 0);

  return {
    ...(schedule.formFee === undefined ? {} : { formFee: schedule.formFee }),
    ...(schedule.admissionFee === undefined
      ? {}
      : { admissionFee: schedule.admissionFee }),
    ...(rents.length > 0
      ? { monthlyRentMax: Math.max(...rents), monthlyRentMin: Math.min(...rents) }
      : {}),
    roomConfigurations,
    unmatched: {
      onCardOnly: schedule.rates
        .map((rate) => rate.roomType)
        .filter((roomType): roomType is string => Boolean(roomType))
        .filter((roomType) => !matched.has(key(roomType))),
      onListingOnly: configurations
        .map((configuration) => configuration.roomType)
        .filter((roomType): roomType is string => Boolean(roomType))
        .filter((roomType) => !matched.has(key(roomType))),
    },
  };
}

/** Writes {@link projectSchedule}'s result onto the hostel. Never throws. */
export async function projectScheduleOntoListing(
  hostelId: Types.ObjectId | string,
  schedule: Pick<FeeScheduleRecord, "admissionFee" | "formFee" | "rates">,
): Promise<ListingProjection | null> {
  try {
    const hostel = await HostelModel.findById(hostelId)
      .select("pricing roomConfigurations")
      .lean<ListingHostel | null>();

    if (!hostel) {
      return null;
    }

    const projection = projectSchedule(hostel, schedule);

    await HostelModel.updateOne(
      { _id: hostelId },
      {
        $set: {
          roomConfigurations: projection.roomConfigurations,
          ...(projection.formFee === undefined ? {} : { "pricing.formFee": projection.formFee }),
          ...(projection.admissionFee === undefined
            ? {}
            : { "pricing.admissionFee": projection.admissionFee }),
          ...(projection.monthlyRentMin === undefined
            ? {}
            : {
                "pricing.monthlyRentMax": projection.monthlyRentMax,
                "pricing.monthlyRentMin": projection.monthlyRentMin,
              }),
        },
      },
    );

    if (projection.unmatched.onCardOnly.length > 0) {
      // Worth a line: a rate nobody can book is usually a room type renamed on
      // one screen and not the other.
      logger.warn("Rate card prices room types this hostel does not list.", {
        hostelId: hostelId.toString(),
        roomTypes: projection.unmatched.onCardOnly,
      });
    }

    return projection;
  } catch (error) {
    logger.error("Could not project the rate card onto the public listing.", {
      error: error instanceof Error ? error.message : String(error),
      hostelId: hostelId.toString(),
    });

    return null;
  }
}
