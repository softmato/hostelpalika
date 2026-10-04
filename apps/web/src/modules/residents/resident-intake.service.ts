import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import {
  bsPeriodBounds,
  formatBsDayRange,
  hostelCalendarDay,
  hostelPeriodOf,
  hostelToday,
} from "@/lib/hostel-day";
import { normalizeBedType } from "@/modules/finance/bed-type";
import {
  computeInvoiceAmount,
  discountRent,
  type FeeScheduleRecord,
  getEffectiveSchedule,
  rateForRoomType,
} from "@/modules/finance/fee-schedule.service";
import { getRentConcession } from "@/modules/finance/rent-concession.service";
import { allocateReferenceCode } from "@/modules/finance/reference-sequence.service";
import { isActiveReferralCode } from "@/modules/referrals/referral.service";
import { HostelModel } from "@hostel/db/models/Hostel";
import { InvoiceModel } from "@hostel/db/models/Invoice";
import type { BedType } from "@hostel/shared/types/bed-type";

/**
 * What a resident is quoted at the door, and the one-off invoice that follows.
 *
 * ## The price is not an input
 *
 * Registering somebody used to mean typing their rent into a box on the intake
 * form, prefilled from the room type and editable afterwards. That is the same
 * mistake `Resident.monthlyFee` documents at length: an unexplained number that
 * outranks the rate card forever, entered by whoever happened to be at the desk.
 * So the quote is computed **here**, from the schedule in force on the move-in
 * date, and the screens render it as a fact rather than a field. A negotiated
 * rate is still possible — it is a per-resident override, set deliberately on
 * the resident's own screen with a reason attached, which is exactly the ritual
 * that makes it explicable later.
 *
 * That also settles who may see it. The rate card itself is behind
 * `viewPayments`, which a warden does not have by default, and a warden who
 * cannot read the card is precisely the person who must not be asked to type a
 * rent. Quoting server-side lets `registerResidents` be the only capability the
 * intake screen needs.
 *
 * ## The referral discount comes off the admission fee, and nothing else
 *
 * A referral is a one-time thank-you for bringing somebody in. Discounting the
 * rent would make the referred resident permanently cheaper than the person in
 * the next bed, and would put a discount into the monthly billing run that
 * nothing there knows how to end. The admission fee is a single charge on a
 * single day, which is the shape a one-time reward actually has.
 *
 * ## The first month is not a whole month
 *
 * Somebody admitted on the 20th owes twenty-nine days of rent for that month and
 * a full month thereafter, and the person at the desk has to be able to say the
 * figure out loud before the resident signs anything. `firstMonth` is that
 * figure, computed by the **same** `computeInvoiceAmount` the billing run uses —
 * not a second implementation of the proration rule that agrees with it until
 * the day it does not. The quote and the invoice are therefore the same
 * arithmetic on the same rate card, which is the only way the number on the
 * screen and the number on the bill are guaranteed to match.
 *
 * It is `null` when there is no rent to prorate (`rentBasis: "UNPRICED"`), for
 * the same reason `monthlyRent` is: a confident zero is worse than an admitted
 * gap.
 *
 * ## Unpriced is a state, not a zero
 *
 * A hostel with no rate card covering the move-in date, or a room type that maps
 * to no bed type, gets `rentBasis: "UNPRICED"` and a null rent — never a
 * confident zero. The screen says the rent will be set by the rate card, and the
 * intake still goes through: the alternative is refusing to admit a paying
 * resident because finance has not been configured yet.
 */

export type RentBasis = "ROOM_CONFIGURATION" | "SCHEDULE" | "UNPRICED";

/**
 * What the move-in month costs, as distinct from what a month costs.
 *
 * `prorated` is the flag a screen branches on rather than comparing `amount`
 * against `monthlyRent` itself: they are equal for anybody moving in on the 1st,
 * and a first-month row that disappears on the 1st of the month is a row nobody
 * can explain.
 */
export type FirstMonthCharge = {
  /** Rupees owed for the move-in month — the whole rent when they arrive on the 1st. */
  amount: number;
  /** Days they are actually resident for, inclusive of the move-in day. */
  billableDays: number;
  /** Length of the BS move-in month, so the screen can say "13 of 31 days". */
  daysInMonth: number;
  /**
   * `Bhadra 19-31` — which days of the month are being charged for.
   *
   * Null when the BS conversion cannot name them. The count is still true in
   * that case; only the words are missing, and a guessed Nepali date on a quote
   * somebody is about to agree to is worse than no date.
   */
  dayRange: string | null;
  /** `2083-05` — the BS period the invoice will carry. */
  period: string;
  /** False when they arrive on the 1st and owe the full month. */
  prorated: boolean;
};

export type IntakeQuote = {
  formFee?: number;
  /** Before the referral discount. */
  admissionFee: number;
  /** What is actually collected at the door: fee less discount, never below 0. */
  admissionPayable: number;
  bedType: BedType | null;
  currency: string;
  depositAmount: number;
  /** The rate card this came from, for the invoice line to point at. */
  feeScheduleId: string | null;
  /** Null when there is no rent to prorate. See `FirstMonthCharge`. */
  firstMonth: FirstMonthCharge | null;
  /** Null when nothing prices this room type — see `rentBasis`. */
  monthlyRent: number | null;
  referral: {
    /** True only when a code was given *and* it is live in this hostel. */
    applied: boolean;
    code: string | null;
    discount: number;
    /** Why a code was not applied, for the field to say so under itself. */
    reason: string | null;
  };
  rentBasis: RentBasis;
  roomType: string;
};

export type QuoteInput = {
  moveInDate?: Date | null;
  referralCode?: string | null;
  roomType: string;
};

type RoomConfiguration = { monthlyRent?: number; roomType: string };

type HostelPricing = {
  pricing?: { formFee?: number; admissionFee?: number; currency?: string };
  referencePrefix?: string;
  roomConfigurations?: RoomConfiguration[];
};

/**
 * "YYYY-MM" for the month a move-in falls in, in the hostel's own reckoning.
 *
 * Not UTC, which is what this used to be. Nepal is UTC+05:45, so the last five
 * and three-quarter hours of every UTC month are already the next month here —
 * and a resident admitted at midnight on 1 September was handed an invoice for
 * **August**, prorated to its final day, against August's rate card. Deriving
 * the period from the calendar day rather than the instant is the whole fix; see
 * `lib/hostel-day.ts`.
 */
export function periodOfDate(date: Date) {
  return hostelPeriodOf(date);
}

/**
 * The whole quote as arithmetic, with every lookup already done.
 *
 * Split out so the rules are testable without a database — a discount larger
 * than the fee, a schedule that prices four bed types but not this one, a room
 * type nobody has costed. Each of those is a real intake somebody will do.
 */
export function quoteIntake(input: {
  /**
   * Percent off the move-in month's rent, if the hostel has discounted it (see
   * `rent-concession.service`). Quoted here because the warden reads this figure
   * out to the resident before they agree to it, and the billing run will charge
   * the discounted one — a quote naming a different number than the bill is the
   * argument this whole module exists to prevent.
   */
  concessionPercent?: number;
  hostel: HostelPricing | null;
  moveInDate?: Date | null;
  referralCode?: string | null;
  /** Whether the code above is live in this hostel. Resolved by the caller. */
  referralCodeActive: boolean;
  roomType: string;
  schedule: FeeScheduleRecord | null;
}): IntakeQuote {
  const bedType = normalizeBedType(input.roomType);
  // The billing run's own lookup, not a second one. Room type first, bed type
  // only for cards written before rates were re-keyed — see `rateForRoomType`.
  const rate = rateForRoomType(input.schedule, input.roomType, bedType);

  /*
   * The rate card first, the room's own `monthlyRent` only as a bootstrap.
   *
   * These used to be two prices maintained side by side, and "they disagree
   * often" was written here as a fact of life: the listing was what the owner
   * typed at signup, the schedule was what billing charged, and quoting one at
   * the door while invoicing the other is how a resident ends up arguing with
   * their first bill. One hostel reached 18,000 on its listing and 180,000 on
   * its card that way.
   *
   * The card is now the source and the listing is written from it
   * (`projectScheduleOntoListing`), so this fallback only covers a hostel that
   * has not opened the rate-card screen yet — which is every hostel on its first
   * day, and the reason it still exists.
   */
  const configured = input.hostel?.roomConfigurations?.find(
    (entry) => entry.roomType === input.roomType,
  );

  const { monthlyRent, rentBasis } = rate
    ? { monthlyRent: rate.monthlyAmount, rentBasis: "SCHEDULE" as const }
    : configured?.monthlyRent
      ? {
          monthlyRent: configured.monthlyRent,
          rentBasis: "ROOM_CONFIGURATION" as const,
        }
      : { monthlyRent: null, rentBasis: "UNPRICED" as const };

  const admissionFee =
    input.schedule?.admissionFee ?? input.hostel?.pricing?.admissionFee ?? 0;

  const code = input.referralCode?.trim().toUpperCase() || null;
  const offered = input.schedule?.referralAdmissionDiscount ?? 0;

  /*
   * Capped at the fee even though the validation refuses a larger discount when
   * the card is written. A card saved before that rule existed, or one whose
   * admission fee was later lowered without the discount following it, would
   * otherwise quote a negative amount payable — an invoice that owes the
   * resident money for moving in.
   */
  const discount = code && input.referralCodeActive ? Math.min(offered, admissionFee) : 0;

  return {
    admissionFee,
    admissionPayable: admissionFee - discount,
    formFee: input.schedule ? (input.schedule.formFee ?? 0) : (input.hostel?.pricing?.formFee ?? 0),
    bedType,
    currency: input.hostel?.pricing?.currency ?? "NPR",
    depositAmount: input.schedule?.depositAmount ?? 0,
    feeScheduleId: input.schedule?._id?.toString() ?? null,
    firstMonth: quoteFirstMonth(
      monthlyRent === null
        ? null
        : discountRent(monthlyRent, input.concessionPercent ?? 0),
      input.moveInDate,
    ),
    monthlyRent,
    referral: {
      applied: discount > 0,
      code,
      discount,
      reason: referralReason({
        active: input.referralCodeActive,
        admissionFee,
        code,
        offered,
      }),
    },
    rentBasis,
    roomType: input.roomType,
  };
}

/**
 * The move-in month priced through the billing run's own rule.
 *
 * Deliberately thin: every judgement about what a partial month costs — how days
 * are counted, which end is inclusive, what rounding does — lives in
 * `computeInvoiceAmount` and is asserted by `fee-schedule.test.ts`. Repeating any
 * of it here would create a second answer to the same question, and the quote is
 * the half a resident reads before they agree to it.
 *
 * A move-in date in a **past** month is still priced against that month, not
 * against today: the invoice `createResident` raises carries that period, and a
 * quote describing a different month than the bill would be worse than no quote.
 */
function quoteFirstMonth(
  monthlyRent: number | null,
  moveInDate: Date | null | undefined,
): FirstMonthCharge | null {
  if (monthlyRent === null) {
    return null;
  }

  const start = moveInDate ? hostelCalendarDay(moveInDate) : hostelToday();
  const period = periodOfDate(start);

  try {
    const charge = computeInvoiceAmount(monthlyRent, start, null, period);
    // The BS month's own length and closing day. Gregorian arithmetic on the
    // period key used to supply the denominator, so a Bhadra quote was divided
    // by September's 30 days while the invoice divided by Bhadra's 31.
    const { daysInMonth, lastDay } = bsPeriodBounds(period);

    return {
      amount: charge.amount,
      billableDays: charge.billableDays,
      // The denominator is the one number the screen needs that the charge does
      // not carry on its own.
      daysInMonth,
      // `Bhadra 19-31` — the days the first month actually covers, so the
      // warden reading the quote out loud can name them.
      dayRange: formatBsDayRange(start, lastDay) || null,
      period,
      prorated: charge.prorationBasis !== null,
    };
  } catch {
    // `computeInvoiceAmount` refuses a rate that is not whole rupees. A rate card
    // that cannot be prorated must not take the whole quote down with it — the
    // rent, the deposit and the admission fee are all still true.
    return null;
  }
}



/**
 * The sentence printed under the referral field.
 *
 * A code that is valid but earns nothing is the case worth naming: the hostel
 * has set no discount, the referrer is still credited, and a screen that said
 * nothing would read as though the code had failed.
 */
function referralReason(input: {
  active: boolean;
  admissionFee: number;
  code: string | null;
  offered: number;
}) {
  if (!input.code) {
    return null;
  }

  if (!input.active) {
    return "That code is not active in this hostel.";
  }

  if (input.admissionFee <= 0) {
    return "This hostel charges no admission fee, so there is nothing to discount. The referrer is still credited.";
  }

  if (input.offered <= 0) {
    return "This hostel offers no referral discount. The referrer is still credited.";
  }

  return null;
}

export async function getIntakeQuote(
  hostelId: Types.ObjectId | string,
  input: QuoteInput,
): Promise<IntakeQuote> {
  await connectToDatabase();

  const moveInDate = input.moveInDate ? hostelCalendarDay(input.moveInDate) : hostelToday();

  const [hostel, schedule, concession, referralCodeActive] = await Promise.all([
    HostelModel.findById(hostelId)
      .select("pricing roomConfigurations")
      .lean<HostelPricing | null>(),
    getEffectiveSchedule(hostelId, periodOfDate(moveInDate)),
    getRentConcession(hostelId, periodOfDate(moveInDate)),
    input.referralCode?.trim()
      ? isActiveReferralCode(input.referralCode, new Types.ObjectId(hostelId.toString()))
      : Promise.resolve(false),
  ]);

  return quoteIntake({
    concessionPercent: concession.percentOff,
    hostel,
    moveInDate,
    referralCode: input.referralCode,
    referralCodeActive,
    roomType: input.roomType,
    schedule: schedule ?? null,
  });
}

export type AdmissionInvoiceResult =
  | { raised: false; reason: string }
  | { amount: number; invoiceId: string; raised: true; referenceCode: string };

/**
 * What a resident owes to join: the admission fee **and** the security deposit,
 * on one invoice, under one reference code.
 *
 * ## Why they are one invoice and not two
 *
 * They are one payment. A resident hands over admission and deposit together at
 * the desk, in one transfer, on the day they arrive — so two invoices would mean
 * two reference codes for one bank transaction, and a transfer quoting one of
 * them settles half of what was paid while the other stays open and ages towards
 * a dunning notice. The deposit was not invoiced at all before this: it sat on
 * the rate card and on the resident record, was quoted at the door, and then
 * appeared on nobody's ledger. The resident's Payments screen showed an
 * admission fee, the hostel collected admission plus deposit, and nothing in the
 * product could explain the difference.
 *
 * So: one invoice, one reference code, one number to transfer.
 *
 * ## And exactly one of them, ever
 *
 * `period: null`, because joining belongs to no month — the invoice's unique
 * double-billing index excludes null periods for exactly this shape of one-off
 * charge, and `receipt.service` already knows a receipt for one covers no span.
 *
 * But that index is therefore *not* protecting this invoice, and joining is the
 * one charge that must never be raised twice: it is not a month that can be
 * re-billed, it is a fee somebody already paid. Both the re-registration and the
 * activation paths reach this. So the check is explicit — an existing non-void
 * joining invoice is returned as it stands, with its original reference code,
 * rather than a second one being written beside it.
 *
 * ## The discount is a negative line, not a smaller fee
 *
 * Both numbers survive on the invoice that way, so a resident asking why they
 * paid less than the advertised admission fee is answered by their own invoice
 * rather than by somebody's memory of a conversation at the desk. Same reason
 * the deposit is its own line rather than folded into a total: a deposit is
 * refundable and a fee is not, and a resident moving out needs to see which half
 * of what they paid is coming back.
 *
 * **Nothing here may fail the registration.** The resident exists, their bed is
 * spent and their referral is linked by the time this runs; throwing would leave
 * a registered resident behind an error message saying they were not registered.
 * A hostel with no reference prefix — the one real failure — gets a reason back
 * and the money is collected the way it was before this existed.
 */
export async function raiseAdmissionInvoice(input: {
  dueDate: Date;
  hostelId: Types.ObjectId | string;
  principal: ApiPrincipal;
  quote: IntakeQuote;
  residentId: Types.ObjectId;
}): Promise<AdmissionInvoiceResult> {
  const deposit = Math.max(input.quote.depositAmount, 0);
  const payable = joiningPayable(input.quote);

  /*
   * A hostel that charges neither raises nothing. Tested on the *pair*, not on
   * the admission fee alone: a hostel that takes only a deposit is a real
   * configuration, and it used to fall through this guard and invoice nobody.
   */
  if (payable <= 0) {
    return { raised: false, reason: "NO_ADMISSION_FEE" };
  }

  try {
    /*
     * Raised once per resident, and this is what enforces it — the unique
     * `(hostelId, residentId, period, kind)` index skips null periods, so
     * nothing below the application layer would stop a second one. A resident
     * re-activated, or registered again after a failed attempt, gets back the
     * invoice and the reference code they were already given.
     */
    const existing = await InvoiceModel.findOne({
      hostelId: input.hostelId,
      kind: "ADMISSION_FEE",
      residentId: input.residentId,
      status: { $ne: "VOID" },
    }).lean<{
      _id: Types.ObjectId;
      referenceCode?: string;
      totalAmount: number;
    } | null>();

    if (existing) {
      return {
        amount: existing.totalAmount,
        invoiceId: existing._id.toString(),
        raised: true,
        referenceCode: existing.referenceCode ?? "",
      };
    }

    const hostel = await HostelModel.findById(input.hostelId)
      .select("referencePrefix")
      .lean<HostelPricing | null>();

    const referenceCode = await allocateReferenceCode(
      input.hostelId,
      hostel?.referencePrefix,
    );

    // A charge taken from the rate card is SCHEDULE; one falling back to the
    // hostel's listed pricing is MANUAL, because no schedule stands behind it
    // and the invoice should not claim one does.
    const basis = input.quote.feeScheduleId ? "SCHEDULE" : "MANUAL";

    const lines: {
      amount: number;
      basis: string;
      description: string;
      feeScheduleId?: string;
    }[] = [];

    if ((input.quote.formFee ?? 0) > 0) {
      lines.push({ amount: input.quote.formFee!, basis, description: "Form fee", feeScheduleId: input.quote.feeScheduleId ?? undefined });
    }

    if (input.quote.admissionFee > 0) {
      lines.push({
        amount: input.quote.admissionFee,
        basis,
        description: "Admission fee",
        feeScheduleId: input.quote.feeScheduleId ?? undefined,
      });
    }

    if (input.quote.referral.discount > 0) {
      lines.push({
        amount: -input.quote.referral.discount,
        basis: "CREDIT",
        description: `Referral discount — code ${input.quote.referral.code}`,
      });
    }

    /*
     * After the discount, deliberately. A referral comes off the admission fee
     * and never off the deposit — a deposit is the resident's own money held
     * back, so discounting it would mean handing back less than was taken. The
     * order the lines are written in is the order they are read in.
     */
    if (deposit > 0) {
      lines.push({
        amount: deposit,
        basis,
        description: "Security deposit",
        feeScheduleId: input.quote.feeScheduleId ?? undefined,
      });
    }

    const invoice = (await InvoiceModel.create({
      createdBy: input.principal.userId,
      currency: input.quote.currency,
      dueDate: input.dueDate,
      hostelId: input.hostelId,
      kind: "ADMISSION_FEE",
      lines,
      period: null,
      referenceCode,
      residentId: input.residentId,
      status: "OPEN",
      totalAmount: payable,
    })) as unknown as { _id: Types.ObjectId };

    return {
      amount: payable,
      invoiceId: invoice._id.toString(),
      raised: true,
      referenceCode,
    };
  } catch (error) {
    return {
      raised: false,
      reason: error instanceof Error ? error.message : "ADMISSION_INVOICE_FAILED",
    };
  }
}

/**
 * The one number a joining resident transfers: admission after any referral
 * discount, plus the deposit.
 *
 * Exported because the intake screen, the registration email and the invoice all
 * have to say the same figure, and three additions of the same two fields is
 * three chances for one of them to forget the deposit — which is exactly how the
 * deposit came to be quoted everywhere and invoiced nowhere.
 */
export function joiningPayable(quote: IntakeQuote): number {
  return Math.max(quote.admissionPayable, 0) + Math.max(quote.depositAmount, 0) + Math.max(quote.formFee ?? 0, 0);
}
