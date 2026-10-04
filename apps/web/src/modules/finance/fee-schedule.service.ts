import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { auditFinanceAction } from "@/modules/finance/audit-finance";
import {
  bsPeriodBounds,
  bsPeriodOf,
  formatBsDayRange,
  formatBsPeriod,
  hostelMonthStart,
} from "@/lib/hostel-day";
import { normalizeBedType } from "@/modules/finance/bed-type";
import { projectScheduleOntoListing } from "@/modules/finance/listing-projection.service";
import { notifyRateCardChanged } from "@/modules/finance/rate-card-notify";
import { FinanceServiceError } from "@/modules/finance/finance.errors";
import { assertWholeRupees, prorate } from "@/modules/finance/money";
import { FeeScheduleModel } from "@hostel/db/models/FeeSchedule";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import type { BedType } from "@hostel/shared/types/bed-type";
import type {
  FeeScheduleCloseInput,
  FeeScheduleCreateInput,
} from "@/modules/finance/fee-schedule.validation";

/**
 * The rate card: what a resident is charged, and for how much of the month
 * (target §3.3–§3.5).
 *
 * This module answers one question — "how much does this resident owe for this
 * period?" — and answers it in exactly one way. The current system asks it in
 * three places that disagree (current §5.1 A1/A2/A3), which is why the same
 * resident can be billed differently depending on which screen an admin opened
 * first.
 */

export type FeeScheduleRate = {
  /** Derived from `roomType`, kept for reporting. Never typed. See the model. */
  bedType?: BedType | null;
  currency?: string;
  monthlyAmount: number;
  /** The hostel's own room type — the key. Absent on pre-migration rows. */
  roomType?: string | null;
};

export type FeeScheduleRecord = {
  _id: Types.ObjectId;
  admissionFee?: number;
  formFee?: number;
  depositAmount?: number;
  effectiveFrom: Date;
  effectiveTo?: Date | null;
  hostelId: Types.ObjectId;
  rates: FeeScheduleRate[];
  /** Comes off `admissionFee` for a referred resident. Never off the rent. */
  referralAdmissionDiscount?: number;
};

/** The subset of a resident this module needs. */
export type BillableResident = {
  _id: Types.ObjectId;
  bedType?: BedType | null;
  monthlyFee?: number | null;
  moveInDate?: Date | null;
  moveOutDate?: Date | null;
  roomType?: string | null;
};

/**
 * Where the number on a rent line came from.
 *
 * `MANUAL` is the hostel's **listed** price for that room type — the figure the
 * owner typed into their room configuration when they signed up. It is the same
 * word `raiseAdmissionInvoice` already uses for a fee that fell back to the
 * listing: no rate card stands behind the line, and the invoice must not claim
 * one does by carrying a `feeScheduleId` it does not have.
 */
export type ChargeBasis = "OVERRIDE" | "SCHEDULE" | "MANUAL";

export type ResolvedCharge = {
  /** What is charged — **after** any month discount. */
  amount: number;
  basis: ChargeBasis;
  bedType: BedType | null;
  /** Percent taken off for this month, 0 when the month is at full rent. */
  concessionPercent: number;
  feeScheduleId: Types.ObjectId | null;
  /** The rent before the month discount. Equal to `amount` when there is none. */
  fullAmount: number;
};

/**
 * The rents an owner typed into their own room configuration, keyed by the room
 * type string the resident record carries.
 *
 * Keyed on the literal `roomType`, deliberately, and **not** on a bed type. A
 * hostel whose only room type is the string `"Shared"` has no bed type at all —
 * `normalizeBedType` cannot say how many people share one — and §7.3 is right
 * that guessing a bed type is not allowed. But it does not follow that the rent
 * is unknown: the owner stated it against that exact string, and matching the
 * string is not a guess about anything.
 *
 * Zero and missing are the same thing here, matching `quoteIntake`: a room
 * configuration with no rent on it has not been priced, and billing somebody
 * nothing is the failure mode this whole module exists to prevent.
 */
export type ListedRoomRates = ReadonlyMap<string, number>;

export function listedRoomRates(
  roomConfigurations:
    | { monthlyRent?: number | null; roomType?: string | null }[]
    | null
    | undefined,
): ListedRoomRates {
  const rates = new Map<string, number>();

  for (const room of roomConfigurations ?? []) {
    if (room?.roomType && typeof room.monthlyRent === "number" && room.monthlyRent > 0) {
      rates.set(room.roomType, room.monthlyRent);
    }
  }

  return rates;
}

/**
 * The Gregorian instants a **Bikram Sambat** period spans.
 *
 * One line of delegation, and the whole point of it: the month a hostel bills is
 * a BS month, its length is 29 to 32 days depending on the year, and there is
 * exactly one table that knows which. This used to compute Gregorian bounds with
 * `Date.UTC(year, month, 0)` and hand a 30-day September to a run that called
 * the result Bhadra.
 *
 * `FinanceServiceError` rather than the shared module's `RangeError`, because
 * every caller here already handles the finance error and reports it per hostel.
 * A Gregorian period key reaching this — a row the migration missed — is the
 * case worth failing loudly on rather than silently dating to 1969.
 */
export function periodBounds(period: string) {
  try {
    return bsPeriodBounds(period);
  } catch (error) {
    throw new FinanceServiceError(
      error instanceof Error ? error.message : `Period must be YYYY-MM, received ${period}.`,
      "FEE_SCHEDULE_MISSING",
    );
  }
}

/**
 * The schedule in force during `period`.
 *
 * A schedule covers the period if it began on or before the period ends and had
 * not closed before the period began — so a schedule that starts mid-month
 * governs that whole month. Splitting a month across two rate cards is a
 * product decision nobody has asked for, and would make an invoice's single
 * `feeScheduleId` a lie.
 */
export async function getEffectiveSchedule(
  hostelId: Types.ObjectId | string,
  period: string,
): Promise<FeeScheduleRecord | null> {
  const { end, start } = periodBounds(period);

  return FeeScheduleModel.findOne({
    effectiveFrom: { $lte: end },
    hostelId,
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: start } }],
  })
    .sort({ effectiveFrom: -1 })
    .lean<FeeScheduleRecord | null>();
}

/**
 * The resident's bed type for pricing.
 *
 * `Resident.bedType` is authoritative when set, but it is a new nullable field
 * that nothing backfills (item 1.1), so this falls back to normalising
 * `roomType` — which is the free text the hostel actually maintains. Null means
 * unmappable, and the caller must fail rather than pick a rate.
 */
export function resolveBedType(resident: BillableResident): BedType | null {
  return resident.bedType ?? normalizeBedType(resident.roomType);
}

/** Case- and punctuation-insensitive, because a room type is text a human typed. */
export function sameRoomType(left: string | null | undefined, right: string | null | undefined) {
  if (!left || !right) {
    return false;
  }

  return (
    left.trim().toUpperCase().replace(/[^A-Z0-9]/g, "") ===
    right.trim().toUpperCase().replace(/[^A-Z0-9]/g, "")
  );
}

/**
 * The one place a rate is looked up on a rate card.
 *
 * **Room type first.** That is the key now, and it is the key precisely because
 * it is the same string the hostel's own room configuration, the resident record
 * and the public listing all use — so there is exactly one number per room type
 * and no way for two of those to disagree. A hostel whose rooms are called
 * `"Shared"` is priceable here and was not before.
 *
 * **Bed type second, for rows written before that.** A schedule saved against
 * the old five-value enum still prices correctly, so nothing has to be migrated
 * before it can be billed. The migration backfills `roomType` and this branch
 * stops being reached.
 *
 * Exported because `quoteIntake` must ask the same question the billing run
 * asks. Two implementations of "what does this room cost" is the defect this
 * whole change exists to remove — the intake quote and the invoice have to be
 * the same arithmetic on the same row.
 */
export function rateForRoomType(
  schedule: FeeScheduleRecord | null | undefined,
  roomType: string | null | undefined,
  bedType: BedType | null = null,
): FeeScheduleRate | null {
  if (!schedule) {
    return null;
  }

  const byRoomType = schedule.rates.find((entry) =>
    sameRoomType(entry.roomType, roomType),
  );

  if (byRoomType) {
    return byRoomType;
  }

  const resolved = bedType ?? normalizeBedType(roomType);

  if (!resolved) {
    return null;
  }

  /*
   * Only a rate that has not been re-keyed yet. A migrated card may hold two
   * room types that normalise to the same bed type — "Private" and "Single
   * Room" are both SINGLE — and matching one of those on bed type would hand
   * back whichever came first, which is the ambiguity room-type keying exists
   * to end.
   */
  return schedule.rates.find((entry) => !entry.roomType && entry.bedType === resolved) ?? null;
}

/**
 * What this resident is charged per month (target §3.4).
 *
 * **Never returns zero as a fallback.** The current implementation's
 * `resident.monthlyFee || input.defaultAmount || 0` chain (current §5.1 A2)
 * means a misconfigured resident is billed nothing and nobody finds out until
 * someone asks in November. Both failure modes here are errors carrying the
 * resident's id, so the billing run reports them per resident and the owner sees
 * "3 residents could not be billed".
 */
export function resolveMonthlyCharge(
  resident: BillableResident,
  schedule: FeeScheduleRecord | null,
  listed: ListedRoomRates = new Map(),
  concessionPercent = 0,
): ResolvedCharge {
  const charge = resolveRentBeforeConcession(resident, schedule, listed);

  return concessionPercent > 0
    ? {
        ...charge,
        amount: discountRent(charge.amount, concessionPercent),
        concessionPercent,
      }
    : charge;
}

/**
 * A month's rent with the festival discount taken off, in whole rupees.
 *
 * The discount is **floored**, so the resident never pays more than the stated
 * share of a rent that does not divide: 50% of 8,001 takes off 4,000 and charges
 * 4,001. Rounding the charge instead would put the odd rupee on the resident's
 * side of a concession the hostel announced as a favour, and no hostel has ever
 * wanted to explain that rupee.
 *
 * Applied to the rent **before** proration, on purpose. A resident who moves in
 * mid-Dashain gets the discount on the days they are there, which is what both
 * halves separately promise; prorating a discounted rent and discounting a
 * prorated rent differ only by rounding, and this order keeps one whole-rupee
 * step instead of two.
 */
export function discountRent(monthlyCharge: number, percentOff: number) {
  if (percentOff <= 0) {
    return monthlyCharge;
  }

  return monthlyCharge - Math.floor((monthlyCharge * percentOff) / 100);
}

function resolveRentBeforeConcession(
  resident: BillableResident,
  schedule: FeeScheduleRecord | null,
  listed: ListedRoomRates = new Map(),
): ResolvedCharge {
  // A per-resident override wins outright, and does not need a schedule: this
  // covers the long-staying resident on an old rate and the negotiated discount
  // (target §3.3). Zero is a legitimate override — a staff member's child — so
  // this tests for null, not for falsiness. That distinction is the whole bug.
  if (resident.monthlyFee !== null && resident.monthlyFee !== undefined) {
    return {
      amount: assertWholeRupees(resident.monthlyFee, "monthly fee override"),
      basis: "OVERRIDE",
      bedType: resolveBedType(resident),
      concessionPercent: 0,
      feeScheduleId: null,
      fullAmount: assertWholeRupees(resident.monthlyFee, "monthly fee override"),
    };
  }

  const bedType = resolveBedType(resident);
  const rate = rateForRoomType(schedule, resident.roomType, bedType);

  if (rate) {
    return {
      amount: assertWholeRupees(rate.monthlyAmount, "scheduled rate"),
      basis: "SCHEDULE",
      bedType,
      concessionPercent: 0,
      feeScheduleId: schedule?._id ?? null,
      fullAmount: assertWholeRupees(rate.monthlyAmount, "scheduled rate"),
    };
  }

  /*
   * The room's own listed rent, and only after the rate card has been asked.
   *
   * This is the same fallback `quoteIntake` already applies, in the same order
   * and for the same stated reason — and the two disagreeing is what this
   * closes. The intake screen quoted the listed price at the door, priced the
   * move-in month from it and printed the figure the warden read out; then the
   * billing run refused the resident because no `FeeSchedule` existed, and the
   * Money tab said **Not billed** with no amount and no reason, for ever.
   * Nothing chased it, because nothing was owed. A hostel that has never opened
   * the rate-card screen — which is most of them on the day they start — could
   * not bill a single resident.
   *
   * The line records `MANUAL` and carries no `feeScheduleId`, so an invoice
   * priced this way is distinguishable from one the rate card produced. That
   * distinction is the honest half: the amount is real and the resident owes it,
   * but no schedule stands behind it, and the owner is still better off writing
   * a rate card.
   */
  const listedRent = resident.roomType ? listed.get(resident.roomType) : undefined;

  if (listedRent !== undefined) {
    return {
      amount: assertWholeRupees(listedRent, "listed room rate"),
      basis: "MANUAL",
      bedType,
      concessionPercent: 0,
      feeScheduleId: null,
      fullAmount: assertWholeRupees(listedRent, "listed room rate"),
    };
  }

  if (!schedule) {
    throw new FinanceServiceError(
      "No fee schedule covers this period, and this room type has no listed rent.",
      "FEE_SCHEDULE_MISSING",
    );
  }

  throw new FinanceServiceError(
    `The rate card has no rate for room type ${JSON.stringify(resident.roomType ?? null)}, and it has no listed rent.`,
    "BED_TYPE_NOT_PRICED",
  );
}

export type InvoiceAmount = {
  amount: number;
  billableDays: number;
  prorationBasis: string | null;
};

/**
 * The one proration rule (target §3.5), run across a Bikram Sambat month.
 *
 * Days are counted inclusively in UTC over the span `periodBounds` gives, which
 * is now the BS month's real extent — 17 Aug to 16 Sep 2026 for Bhadra 2083, 31
 * days — rather than a Gregorian month wearing its name. Note this prorates
 * **move-out** as well, which the system it replaced did not do at all: a
 * resident leaving on the 8th was charged the whole month.
 *
 * ## `prorationBasis` names the days, not just how many
 *
 * It is the explanation carried onto the invoice line, so a resident asking "why
 * is this less than usual?" is answered by the invoice rather than by the hostel
 * owner. `"13/31 days"` did not answer it: a fraction says how much was charged
 * and nothing about *which* days, so a resident checking a mid-month move-in
 * against their own memory had nothing to check it against. `"Bhadra 19-31 · 13
 * of 31 days"` is the same arithmetic with the span in front of it.
 *
 * Snapshotted onto the line at issue time like every other figure here, so it
 * stays true after the rate card it came from is closed.
 *
 * The span is dropped rather than guessed if the BS conversion cannot name the
 * days — the fraction alone is still correct, and a confidently wrong Nepali
 * date on a bill is the one outcome worth avoiding.
 */
export function computeInvoiceAmount(
  monthlyCharge: number,
  moveInDate: Date | null | undefined,
  moveOutDate: Date | null | undefined,
  period: string,
): InvoiceAmount {
  assertWholeRupees(monthlyCharge, "monthly charge");

  const { daysInMonth, end, lastDay, start } = periodBounds(period);

  if (moveInDate && moveInDate > end) {
    return { amount: 0, billableDays: 0, prorationBasis: "not yet resident" };
  }

  if (moveOutDate && moveOutDate < start) {
    return { amount: 0, billableDays: 0, prorationBasis: "already moved out" };
  }

  const billableStart = moveInDate && moveInDate > start ? moveInDate : start;

  /*
   * Clamped to `lastDay`, not `end`. `end` is 23:59:59.999 UTC, which Kathmandu
   * has already carried into the following morning — so naming the range from it
   * would print a Bhadra invoice as covering days up to "Aswin 1". The day count
   * is unaffected either way; only the words are.
   */
  const billableEnd = moveOutDate && moveOutDate < end ? moveOutDate : lastDay;

  if (billableEnd < billableStart) {
    return { amount: 0, billableDays: 0, prorationBasis: "no billable days" };
  }

  const billableDays = countDaysInclusive(billableStart, billableEnd);
  const amount = prorate(monthlyCharge, billableDays, daysInMonth);

  if (billableDays >= daysInMonth) {
    return { amount, billableDays, prorationBasis: null };
  }

  const span = formatBsDayRange(billableStart, billableEnd);
  const fraction = `${billableDays} of ${daysInMonth} days`;

  return {
    amount,
    billableDays,
    prorationBasis: span ? `${span} · ${fraction}` : fraction,
  };
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Calendar days from `from` to `to`, both included. */
function countDaysInclusive(from: Date, to: Date) {
  const startDay = Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate());
  const endDay = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());

  return Math.floor((endDay - startDay) / MS_PER_DAY) + 1;
}

/* -------------------------------------------------------------------------- */
/*                                    CRUD                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every rate card this hostel has had, newest first, each labelled.
 *
 * `standing` is computed here rather than left to the screens, and that is the
 * fix for the thing an owner actually saw: a card starting 17 Aswin was drawn
 * with a green **Active** badge because it was the row with `effectiveTo: null`,
 * while the rates genuinely billing residents that day were on a card the same
 * screen filed under history. "Open" and "in force" are not the same thing for
 * the month between setting rates and them starting, and every reader that
 * conflated them told the owner something false.
 */
export async function listFeeSchedules(hostelId: Types.ObjectId | string) {
  await connectToDatabase();

  const schedules = await FeeScheduleModel.find({ hostelId })
    .sort({ effectiveFrom: -1 })
    .lean<FeeScheduleRecord[]>();

  return labelSchedules(schedules);
}

/**
 * The open row — the one a new card will displace.
 *
 * Note this is **not** necessarily the card in force today: between setting next
 * month's rates and that month arriving, the open row is an upcoming card and
 * the rates actually billing residents are on a closed one. Use
 * {@link getEffectiveSchedule} for "what am I charging right now"; this is for
 * "what does a new card replace".
 */
export async function getOpenFeeSchedule(hostelId: Types.ObjectId | string) {
  await connectToDatabase();

  return FeeScheduleModel.findOne({
    effectiveTo: null,
    hostelId,
  }).lean<FeeScheduleRecord | null>();
}

/**
 * Opens a new schedule, closing the current one the day before it starts.
 *
 * ## Rates change on the first of a month
 *
 * `effectiveFrom` is pulled back to the start of whatever month it names. A card
 * starting on the 17th would split that month across two prices, which nothing
 * downstream can express — `getEffectiveSchedule` hands a whole month to one
 * card, and an invoice carries a single `feeScheduleId`. An owner pressed a
 * "next month" button that added thirty days, got a card starting 17 Aswin, and
 * the screen then told them rates were live that would not apply for another
 * four weeks.
 *
 * ## A card that has not started yet is not history
 *
 * "Never an edit" (target §3.3) protects invoices: the rates an invoice was
 * computed from must stay readable. A **future** card has priced nothing — no
 * month has been billed from it and no invoice references it — so replacing it
 * is not rewriting history, and refusing to was a trap. An owner who set October
 * wrong could not correct it until October arrived, because the guard here only
 * compared dates. Replacing a not-yet-started card deletes it outright; anything
 * that has governed a month is closed, never touched.
 *
 * ## The running month is frozen
 *
 * A hostel with a rate card may only start a new one from a *future* month.
 * Changing the rate a resident is already being billed at, mid-month, is the
 * silent rewrite the versioning exists to prevent. The first card a hostel ever
 * writes is the exception: it may start this month, because until it exists
 * nobody can be billed at all.
 */
export async function createFeeSchedule(
  hostelId: Types.ObjectId | string,
  input: FeeScheduleCreateInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const effectiveFrom = hostelMonthStart(input.effectiveFrom);
  const thisMonth = hostelMonthStart(new Date());

  const current = await FeeScheduleModel.findOne({
    effectiveTo: null,
    hostelId,
  }).lean<FeeScheduleRecord | null>();

  /*
   * What residents are actually paying **today**, read before anything below
   * closes or deletes a card.
   *
   * Deliberately not `current`. That is the open-ended card, which is often an
   * unstarted draft for a future month — and replacing a draft would compare the
   * new rates against numbers nobody has ever been charged, telling residents
   * their rent "changed from" a price that never existed. The card in effect this
   * month is the only honest baseline for that sentence.
   */
  const inEffect = await getEffectiveSchedule(hostelId, bsPeriodOf(new Date()));

  if (current) {
    if (effectiveFrom <= thisMonth) {
      throw new FinanceServiceError(
        "Rates can only change from the start of a future month. This month's residents are already being billed at the current rates.",
        "FEE_SCHEDULE_MONTH_LOCKED",
      );
    }

    if (effectiveFrom.getTime() === hostelMonthStart(current.effectiveFrom).getTime()) {
      /*
       * Replacing a card that has not started. It has priced nothing, so there
       * is no history to keep — leaving it closed-but-present would litter the
       * card list with drafts nobody can tell apart.
       */
      await FeeScheduleModel.deleteOne({ _id: current._id });
    } else if (effectiveFrom < current.effectiveFrom) {
      throw new FinanceServiceError(
        `The rate card already changes in ${formatBsPeriod(bsPeriodOf(current.effectiveFrom)) || current.effectiveFrom.toISOString().slice(0, 10)}. Replace that one, or pick a later month.`,
        "FEE_SCHEDULE_MISSING",
      );
    } else {
      await FeeScheduleModel.updateOne(
        { _id: current._id },
        { $set: { effectiveTo: dayBefore(effectiveFrom) } },
      );
    }
  }

  /*
   * `bedType` is derived here, never taken from the request. It is a reporting
   * label — the vocabulary that makes one hostel's "Two Sharing" and another's
   * "Double Room" one row in a platform report — and a label the client could
   * set is a label that can contradict the room type it sits beside.
   */
  const rates = input.rates.map((rate) => ({
    bedType: rate.roomType ? normalizeBedType(rate.roomType) : (rate.bedType ?? null),
    currency: rate.currency,
    monthlyAmount: rate.monthlyAmount,
    roomType: rate.roomType,
  }));

  const created = (await FeeScheduleModel.create({
    admissionFee: input.admissionFee, formFee: input.formFee ?? 0,
    createdBy: principal.userId,
    depositAmount: input.depositAmount,
    effectiveFrom,
    effectiveTo: null,
    hostelId,
    rates,
    referralAdmissionDiscount: input.referralAdmissionDiscount,
  })) as unknown as FeeScheduleRecord;

  /*
   * And the public listing, which is a view of this document rather than a
   * second copy of it. Deliberately after the write and deliberately unable to
   * fail it: the rate card is the record that matters, and a stale listing is a
   * smaller problem than a rate change reported as failed after it succeeded.
   */
  await projectScheduleOntoListing(hostelId, { admissionFee: input.admissionFee, formFee: input.formFee ?? 0, rates });

  /*
   * And the residents whose rent this just changed.
   *
   * After the write and unable to fail it, for the same reason the listing
   * projection above is: the card is the record that matters. Only residents
   * whose own room type moved are written to — see `notifyRateCardChanged`.
   */
  await notifyRateCardChanged({
    effectiveFrom,
    hostelId,
    previousRates: inEffect?.rates ?? null,
    rates,
  });

  // A rate card is what every future invoice is computed from, so a change to
  // it is a finance action even though no money moves today.
  await auditFinanceAction(principal, {
    action: "FEE_SCHEDULE_CREATED",
    amountAfter: totalOfRates(input.rates),
    amountBefore: current ? totalOfRates(current.rates) : 0,
    entityId: created._id,
    entityType: "FeeSchedule",
    hostelId,
    source: "FEE_SCHEDULE_EDITOR",
  });

  return created;
}

export type ScheduleStanding = "current" | "past" | "upcoming";

/**
 * Whether a rate card has started, and therefore whether it may be changed.
 *
 * The whole editing rule in one word. A card that is pricing residents right now
 * is history — an invoice may already carry its id — so it is only readable. A
 * card for a future month has priced nobody, and an owner who typed it wrong
 * must be able to fix or drop it before it takes effect. Refusing that was the
 * trap: October's rates were set by mistake and could not be corrected until
 * October arrived.
 *
 * **`current` is decided the way billing decides it**, not by whether
 * `effectiveTo` is null. Those are different questions and the difference is not
 * academic: this hostel's September rates sit on a card that was closed on
 * 1 October to make room for a successor, so it has an `effectiveTo` and would
 * read as finished — while the card with no `effectiveTo` does not start for
 * another month. Both readings were wrong in opposite directions on the same
 * screen. So the current card is the one {@link getEffectiveSchedule} would
 * return for this month: the newest whose span covers it.
 */
export function labelSchedules<
  T extends Pick<FeeScheduleRecord, "effectiveFrom" | "effectiveTo">,
>(schedules: T[], now: Date = new Date()): (T & { standing: ScheduleStanding })[] {
  /*
   * The running month's own bounds, taken from the BS calendar rather than
   * stepped forward with `Date.UTC(..., month + 1, 0)`. That Gregorian step read
   * the first day of a BS month and then added a *Gregorian* month to it, so the
   * window it produced covered neither month: mid-Bhadra to mid-Aswin, which put
   * an Aswin card and a Bhadra card inside the same "current" span and let
   * whichever started later win.
   */
  const monthStart = hostelMonthStart(now);
  const monthEnd = bsPeriodBounds(bsPeriodOf(now)).end;

  const covers = (schedule: T) =>
    schedule.effectiveFrom <= monthEnd &&
    (schedule.effectiveTo === null ||
      schedule.effectiveTo === undefined ||
      schedule.effectiveTo >= monthStart);

  // Newest start wins, exactly as `getEffectiveSchedule` sorts.
  const currentId = [...schedules]
    .filter(covers)
    .sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime())[0];

  return schedules.map((schedule) => ({
    ...schedule,
    standing:
      schedule === currentId
        ? ("current" as const)
        : schedule.effectiveFrom > monthEnd
          ? ("upcoming" as const)
          : ("past" as const),
  }));
}

/** One card's standing, when the whole list is not to hand. */
export function scheduleStanding(
  schedule: Pick<FeeScheduleRecord, "effectiveFrom" | "effectiveTo">,
  now: Date = new Date(),
): ScheduleStanding {
  return labelSchedules([schedule], now)[0]!.standing;
}

/**
 * Drops a rate card that has not started yet, and puts the previous one back.
 *
 * ## Only an upcoming card
 *
 * Deleting a card that has priced a month would leave every invoice raised from
 * it pointing at a `feeScheduleId` that no longer resolves — "what was this
 * resident's rent in March?" would stop having an answer, which is the exact
 * question the versioning exists to answer. Refused, not soft-deleted: a card
 * you cannot see but that still owns invoices is worse than either.
 *
 * ## Putting the previous card back
 *
 * Opening a card closed its predecessor the day before it starts. Deleting it
 * has to undo that, or the hostel is left with no open card at all and billing
 * stops for everybody — a delete on next month's rates silently breaking this
 * month's. The most recent closed card is re-opened (`effectiveTo: null`), so
 * the rates that were running before simply carry on.
 */
export async function deleteFeeSchedule(
  hostelId: Types.ObjectId | string,
  scheduleId: string,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const schedule = await FeeScheduleModel.findOne({
    _id: scheduleId,
    hostelId,
  }).lean<FeeScheduleRecord | null>();

  if (!schedule) {
    throw new FinanceServiceError("Fee schedule was not found.", "FEE_SCHEDULE_MISSING");
  }

  if (scheduleStanding(schedule) !== "upcoming") {
    throw new FinanceServiceError(
      "Only rates that have not started yet can be deleted. These are already billing residents.",
      "FEE_SCHEDULE_MONTH_LOCKED",
    );
  }

  /*
   * Belt and braces. `scheduleStanding` says no month has begun under this card,
   * so nothing should reference it — but a manual back-dated billing run is a
   * thing a person can do, and an orphaned invoice basis is unrecoverable.
   */
  const invoiced = await InvoiceModel.countDocuments({
    "lines.feeScheduleId": schedule._id,
  });

  if (invoiced > 0) {
    throw new FinanceServiceError(
      `These rates have already priced ${invoiced} invoice(s) and cannot be deleted.`,
      "FEE_SCHEDULE_IN_USE",
    );
  }

  await FeeScheduleModel.deleteOne({ _id: schedule._id });

  // And the card this one displaced goes back to being the current one, so the
  // hostel is never left unable to bill.
  const previous = await FeeScheduleModel.findOne({
    _id: { $ne: schedule._id },
    effectiveFrom: { $lt: schedule.effectiveFrom },
    hostelId,
  })
    .sort({ effectiveFrom: -1 })
    .lean<FeeScheduleRecord | null>();

  if (previous) {
    await FeeScheduleModel.updateOne(
      { _id: previous._id },
      { $set: { effectiveTo: null } },
    );

    // The listing follows whichever card is now current.
    await projectScheduleOntoListing(hostelId, {
      admissionFee: previous.admissionFee,
      formFee: previous.formFee,
      rates: previous.rates,
    });
  }

  await auditFinanceAction(principal, {
    action: "FEE_SCHEDULE_CLOSED",
    amountAfter: previous ? totalOfRates(previous.rates) : 0,
    amountBefore: totalOfRates(schedule.rates),
    entityId: schedule._id,
    entityType: "FeeSchedule",
    hostelId,
    reason: "Upcoming rates deleted before they took effect.",
    source: "FEE_SCHEDULE_EDITOR",
  });

  return {
    deletedId: schedule._id.toString(),
    restoredId: previous?._id.toString() ?? null,
  };
}

export async function closeFeeSchedule(
  hostelId: Types.ObjectId | string,
  scheduleId: string,
  input: FeeScheduleCloseInput,
  principal: ApiPrincipal,
) {
  await connectToDatabase();

  const schedule = await FeeScheduleModel.findOne({
    _id: scheduleId,
    hostelId,
  }).lean<FeeScheduleRecord | null>();

  if (!schedule) {
    throw new FinanceServiceError("Fee schedule was not found.", "FEE_SCHEDULE_MISSING");
  }

  if (input.effectiveTo < schedule.effectiveFrom) {
    throw new FinanceServiceError(
      "A schedule cannot close before it starts.",
      "FEE_SCHEDULE_MISSING",
    );
  }

  await FeeScheduleModel.updateOne(
    { _id: schedule._id },
    { $set: { effectiveTo: input.effectiveTo } },
  );

  await auditFinanceAction(principal, {
    action: "FEE_SCHEDULE_CLOSED",
    amountAfter: 0,
    amountBefore: totalOfRates(schedule.rates),
    entityId: schedule._id,
    entityType: "FeeSchedule",
    hostelId,
    source: "FEE_SCHEDULE_EDITOR",
  });

  return { ...schedule, effectiveTo: input.effectiveTo };
}

/**
 * Sum of the rate card. Not a price anyone pays — it is the auditable "what
 * changed" figure for a rate-card edit, which `auditFinanceAction` requires.
 */
function totalOfRates(rates: FeeScheduleRate[]) {
  return rates.reduce((total, rate) => total + rate.monthlyAmount, 0);
}

function dayBefore(date: Date) {
  return new Date(date.getTime() - MS_PER_DAY);
}
