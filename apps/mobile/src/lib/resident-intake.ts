import type { ResidentPrefill } from "@/lib/admin-manage-api";
import { type CalendarSystem, formatDateIn } from "@/lib/calendar";
import { humanizeEnum } from "@/lib/format";

/**
 * Turning a scanned profile into the rows the confirm step reads out.
 *
 * ## Why this is a list and not a component
 *
 * The intake screen shows the resident's own answers back to the warden so they
 * can look up from the phone and check them against the person standing there.
 * That reading happens out loud — "Asha Rai, twenty, B positive, father Ram" —
 * so the *order* is the feature, and an order that lives inside JSX cannot be
 * tested. Everything here is a pure function over the prefill, so the rules
 * about what is shown, what is hidden and what it is called are checked by
 * `resident-intake.test.ts` rather than by squinting at a screenshot.
 *
 * ## An empty row is worse than a missing one
 *
 * The web summary prints an em dash for every blank, which is defensible in a
 * four-column grid where the columns must line up. On a phone the rows are
 * stacked, and eight dashes in a column is a screen that looks broken while
 * saying nothing. So a blank is **dropped**, and the sections that end up empty
 * do not render at all.
 *
 * The one exception is anything the hostel is responsible for knowing — a blood
 * group, an allergy. Those are absent rather than blank, and the screen says so
 * in words, because "we were not told" and "we forgot to look" have to be
 * distinguishable at three in the morning.
 */

export type IntakeFact = { label: string; value: string };

export type IntakePerson = {
  /** What this person is to the resident: `Father`, `Mother`, `Emergency`. */
  label: string;
  name: string;
  phone: string;
};

/** Drops the blanks, so a section can ask whether it has anything to show. */
function facts(entries: [string, string | null | undefined][]): IntakeFact[] {
  return entries
    .filter(([, value]) => Boolean(value && value.trim()))
    .map(([label, value]) => ({ label, value: (value as string).trim() }));
}

export function residentFullName(prefill: ResidentPrefill) {
  return `${prefill.resident.firstName} ${prefill.resident.lastName}`.trim();
}

/**
 * Who they are — the rows a warden checks against the face in front of them.
 *
 * Name, then the two things a stranger can be verified by on sight (age and
 * gender), then the number that reaches them. The government ID is last because
 * it is the row nobody reads aloud and everybody needs later.
 */
export function identityFacts(
  prefill: ResidentPrefill,
  /*
   * The warden's calendar. This is an admin screen and the date of birth is the
   * one date on it — printed in Gregorian while every other date the warden had
   * seen that minute was in Bikram Sambat, it reads as a different person's
   * record. Required rather than defaulted, so a new call site cannot forget it.
   */
  calendar: CalendarSystem,
): IntakeFact[] {
  const { details, resident } = prefill;

  return facts([
    ["Full name", residentFullName(prefill)],
    ["Age", details.age ? `${details.age} years` : null],
    [
      "Date of birth",
      details.dateOfBirth ? formatDateIn(calendar, details.dateOfBirth) : null,
    ],
    ["Gender", details.gender ? humanizeEnum(details.gender) : null],
    ["Phone", resident.phone],
    ["Alternate phone", details.alternatePhone],
    ["Email", resident.email],
    [
      // Labelled by the document they actually carry, so the row reads
      // "Citizenship" rather than the generic word on a card that names itself.
      details.governmentIdType ? humanizeEnum(details.governmentIdType) : "Government ID",
      details.governmentIdNumber,
    ],
  ]);
}

/** Where they are from, and what they do — the address and occupation block. */
export function backgroundFacts(prefill: ResidentPrefill): IntakeFact[] {
  const { details, resident } = prefill;

  return facts([
    [
      "Home address",
      [details.permanentAddress, details.city, details.province]
        .filter(Boolean)
        .join(", "),
    ],
    ["Currently", resident.residentType ? humanizeEnum(resident.residentType) : null],
    ["Studying / working at", details.institution],
    ["Course or role", details.courseOrDesignation],
    ["Interests", details.interests.length > 0 ? details.interests.join(", ") : null],
  ]);
}

/**
 * The rows the hostel is answerable for.
 *
 * Blood group and food are always rendered, absent or not: an intake that
 * silently omitted a blood group looks identical to one where nobody asked, and
 * the difference matters on the night it matters.
 */
export function careFacts(prefill: ResidentPrefill): IntakeFact[] {
  const { details } = prefill;

  return [
    {
      label: "Blood group",
      value:
        details.bloodGroup && details.bloodGroup !== "UNKNOWN"
          ? details.bloodGroup
          : "Not stated",
    },
    {
      label: "Food",
      value: details.dietaryPreference
        ? humanizeEnum(details.dietaryPreference)
        : "Not stated",
    },
  ];
}

/**
 * Guardians and the emergency contact, as one list of people.
 *
 * Labelled by **relation** rather than by role, so a warden reads "Father" and
 * "Mother" — which is how the person in front of them describes their own
 * family — instead of "Guardian" and "Second guardian", which is how the
 * database happens to store it. `isPrimary` still decides the order.
 */
export function intakePeople(prefill: ResidentPrefill): IntakePerson[] {
  const guardians = [...prefill.guardians]
    .sort((left, right) => Number(right.isPrimary) - Number(left.isPrimary))
    .map((guardian) => ({
      label: guardian.relation ? humanizeEnum(guardian.relation) : "Guardian",
      name: `${guardian.firstName} ${guardian.lastName}`.trim(),
      phone: guardian.phone,
    }));

  const emergency = prefill.emergencyContact;

  /*
   * The server falls back to the guardian's own details when the resident named
   * no separate emergency contact, so the same person arrives twice. Printing
   * them twice reads as two people to call, and a warden who rings the second
   * number in a crisis has wasted the only minute that counted.
   */
  const duplicated = guardians.some(
    (person) => person.phone === emergency.phone && person.name === emergency.name,
  );

  if (!emergency.name || !emergency.phone || duplicated) {
    return guardians;
  }

  return [
    ...guardians,
    {
      label: emergency.relation
        ? `Emergency · ${humanizeEnum(emergency.relation)}`
        : "Emergency contact",
      name: emergency.name,
      phone: emergency.phone,
    },
  ];
}

/**
 * The sentence under the rent, saying where the figure came from.
 *
 * `UNPRICED` is the one that has to be honest: the intake still goes through,
 * but nothing has costed this room type, and a screen that showed a confident
 * zero there would be quoting a free stay to somebody who is about to pay.
 */
export function rentBasisNote(
  basis: "ROOM_CONFIGURATION" | "SCHEDULE" | "UNPRICED",
): string {
  if (basis === "SCHEDULE") {
    return "From the hostel's current rate card. Billing uses the same figure.";
  }

  if (basis === "ROOM_CONFIGURATION") {
    return "From this room type's listed rent — no rate card covers the move-in date yet.";
  }

  return "Nothing prices this room type yet. Set a rate card before the first bill.";
}

/**
 * The sentence under the first month's figure.
 *
 * ## Why the arithmetic is spelled out and not just the total
 *
 * "NPR 2,323" beside "Monthly rent NPR 6,000" is a number a resident will
 * dispute at the desk, and the person admitting them has to be able to answer
 * without opening a calculator. `12 of 31 days` is the whole explanation, and it
 * is the same fraction printed on the invoice line the server raises
 * (`prorationBasis`), so the two documents agree word for word.
 *
 * A full first month gets a different sentence rather than the same one reading
 * `31 of 31 days`, which is arithmetic nobody needed to see.
 */
export function firstMonthNote(charge: {
  billableDays: number;
  daysInMonth: number;
  prorated: boolean;
}): string {
  return charge.prorated
    ? `${charge.billableDays} of ${charge.daysInMonth} days — billed when you register them. Full rent from the month after.`
    : "A full month, because they arrive on the 1st. Billed when you register them.";
}


/**
 * What the resident can hand over before they leave the desk.
 *
 * ## The codes were on the wire and went in the bin
 *
 * `createResident` raises up to two invoices and returns a reference code for
 * each. The screen read neither: it toasted "their admission fee is invoiced
 * too" and navigated away, so a resident who had their phone out and wanted to
 * settle the joining bill on the spot had to be told to go home, open the app,
 * find Payments, and read a code that the warden's screen had been holding all
 * along. This turns that response into the two or three lines somebody says out
 * loud while the person is still standing there.
 *
 * ## Two invoices means two codes, and they are not interchangeable
 *
 * The joining charge and the first month are separate invoices — separate
 * periods, separate `kind`s, separate codes — so they are separate rows here
 * rather than one summed total under one code. A single "Collect NPR 18,800"
 * with either code under it is the mistake this is written to make impossible:
 * a transfer quoting the admission code settles the admission invoice and
 * leaves the rent open, whatever figure was sent.
 *
 * ## The joining row names both charges
 *
 * `admission.amount` is the fee *after* any referral discount **plus the
 * deposit** — see `raiseAdmissionInvoice`, which writes all three as lines on
 * one invoice. A row labelled "Admission fee" over that figure overstates the
 * fee by the size of the deposit, which is usually the larger half, so the
 * label is built from the quote the same way the server built the lines.
 *
 * ## Read defensively, like every other reader of this response
 *
 * The phone talks to whatever API version `EXPO_PUBLIC_API_URL` points at, so
 * every field here is optional and a bill with no code is dropped rather than
 * rendered as an empty strip. A code nobody can quote is not a way to pay.
 */
export type CollectableBill = {
  amount: number;
  /** `Admission fee + Security deposit`, `Monthly rent — Bhadra`. */
  label: string;
  referenceCode: string;
};

type IntakeBills = {
  admission?: {
    amount?: number;
    raised?: boolean;
    reason?: string;
    referenceCode?: string;
  } | null;
  firstMonth?: {
    amount?: number;
    period?: string;
    raised?: boolean;
    reason?: string;
    referenceCode?: string;
  } | null;
  quote?: { formFee?: number; admissionFee?: number; depositAmount?: number } | null;
};

export function collectableBills(
  result: IntakeBills,
  monthLabel: (period: string | null) => string,
): CollectableBill[] {
  const bills: CollectableBill[] = [];

  const admission = result.admission;

  if (admission?.raised && admission.referenceCode && (admission.amount ?? 0) > 0) {
    bills.push({
      amount: admission.amount as number,
      label: joiningLabel(result.quote),
      referenceCode: admission.referenceCode,
    });
  }

  const firstMonth = result.firstMonth;

  if (firstMonth?.raised && firstMonth.referenceCode && (firstMonth.amount ?? 0) > 0) {
    bills.push({
      amount: firstMonth.amount as number,
      label: `Monthly rent — ${monthLabel(firstMonth.period ?? null)}`,
      referenceCode: firstMonth.referenceCode,
    });
  }

  return bills;
}

/**
 * What the joining invoice is called, from the charges that went onto it.
 *
 * The same three cases `raiseAdmissionInvoice` writes lines for: a hostel that
 * takes only a deposit is a real configuration, and calling its one charge an
 * admission fee would be a description of money the resident is not being
 * asked for.
 */
function joiningLabel(quote: IntakeBills["quote"]): string {
  const fee = (quote?.admissionFee ?? 0) > 0;
  const deposit = (quote?.depositAmount ?? 0) > 0;

  return [fee ? "Admission fee" : "", (quote?.formFee ?? 0) > 0 ? "Form fee" : "", deposit ? "Security deposit" : ""].filter(Boolean).join(" + ") || "Admission fee";
}
