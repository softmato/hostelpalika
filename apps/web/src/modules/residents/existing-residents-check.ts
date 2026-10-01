import { addBsMonths, bsPeriodBounds, formatBsPeriod } from "@/lib/hostel-day";
import { computeInvoiceAmount } from "@/modules/finance/fee-schedule.service";

/**
 * "Check list" for the existing-residents list (docs/EXISTING_RESIDENTS.md, item 4).
 *
 * Pure: every lookup is done by the caller and handed in as `CheckContext`, so
 * each rule is a test without a database. The words are the screen's words —
 * plain English a hostel owner in Nepal reads without a dictionary, and each one
 * says what to do, not only what is wrong.
 */

/** How far back "Rent paid till" may go. Older money goes in Old dues. */
export const MAX_MONTHS_BACK = 12;
/** How far ahead — a year paid in advance is real, more than that is a typo. */
export const MAX_MONTHS_AHEAD = 12;

export type ListRow = {
  depositPaid: number;
  email: string;
  fullName: string;
  id: string;
  /** ISO string, or null. */
  joinedDate: string | null;
  monthlyRent: number | null;
  oldDues: number;
  paidTill: string | null;
  /** Rent already paid towards the oldest month due. */
  partPaid: number;
  phone: string;
  /** Set once this row has been added as a resident. */
  residentId: string | null;
  roomType: string;
};

export type RoomTypeContext = {
  /** Null when neither the room list nor the rate card prices this room. */
  monthlyRent: number | null;
  roomType: string;
  vacantBeds: number;
};

export type CheckContext = {
  currentPeriod: string;
  /** Residents of *other* hostels, by lower-case email → that hostel's name. */
  livingElsewhere: Map<string, string>;
  roomTypes: RoomTypeContext[];
  /** This hostel's own residents, by email → their name. */
  takenEmails: Map<string, string>;
  /** This hostel's own residents, by phone → their name. */
  takenPhones: Map<string, string>;
};

export type RowField =
  | "email"
  | "fullName"
  | "joinedDate"
  | "monthlyRent"
  | "paidTill"
  | "partPaid"
  | "phone"
  | "roomType";

export type RowProblem = { field: RowField; message: string };

export type BillPreview = {
  /** Rent months that will be billed when the list is added, oldest first. */
  months: { amount: number; label: string; period: string }[];
  oldDues: number;
  /** Comes off the first month in `months`. */
  partPaid: number;
  total: number;
};

export type CheckedRow = {
  /** Null until the row has what it needs to be priced. */
  bills: BillPreview | null;
  id: string;
  added: boolean;
  problems: RowProblem[];
  /** The rent this resident will pay each month from here on. */
  rent: number | null;
};

export type RoomTypeSummary = {
  freeBeds: number;
  inList: number;
  roomType: string;
};

export type CheckResult = {
  /** Problems about the whole list rather than one line. */
  listProblems: string[];
  ready: boolean;
  roomTypes: RoomTypeSummary[];
  rows: CheckedRow[];
  toAdd: number;
  withProblems: number;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function sameRoomType(a: string, b: string) {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

export function splitFullName(fullName: string): { firstName: string; lastName: string } | null {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);

  if (parts.length < 2) {
    return null;
  }

  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1]! };
}

export function monthLabel(period: string) {
  return (formatBsPeriod(period) || period).replace(/\s*BS$/, "");
}

/** The day billing counts a resident from: their joined date, or the start of the paid month. */
export function moveInDateFor(row: Pick<ListRow, "joinedDate" | "paidTill">): Date | null {
  if (row.joinedDate) {
    return new Date(row.joinedDate);
  }

  return row.paidTill ? bsPeriodBounds(row.paidTill).start : null;
}

/** Every month after `paidTill` up to and including `currentPeriod`. */
export function unpaidMonths(paidTill: string, currentPeriod: string): string[] {
  const months: string[] = [];

  for (let period = addBsMonths(paidTill, 1); period <= currentPeriod; period = addBsMonths(period, 1)) {
    months.push(period);
  }

  return months;
}

export function checkExistingResidents(rows: ListRow[], context: CheckContext): CheckResult {
  const oldest = addBsMonths(context.currentPeriod, -MAX_MONTHS_BACK);
  const newest = addBsMonths(context.currentPeriod, MAX_MONTHS_AHEAD);
  const firstLineWithPhone = new Map<string, number>();
  const firstLineWithEmail = new Map<string, number>();
  const summaries = new Map<string, RoomTypeSummary>();
  const listProblems: string[] = [];

  for (const room of context.roomTypes) {
    summaries.set(room.roomType.toLowerCase(), {
      freeBeds: room.vacantBeds,
      inList: 0,
      roomType: room.roomType,
    });
  }

  if (context.roomTypes.length === 0) {
    listProblems.push("This hostel has no room types yet. Add rooms first.");
  }

  const checked = rows.map((row, index): CheckedRow => {
    const line = index + 1;

    if (row.residentId) {
      return { added: true, bills: null, id: row.id, problems: [], rent: null };
    }

    const problems: RowProblem[] = [];
    const add = (field: RowField, message: string) => problems.push({ field, message });

    if (!row.fullName.trim()) {
      add("fullName", "Write the full name.");
    } else if (!splitFullName(row.fullName)) {
      add("fullName", "Write first and last name.");
    }

    const phoneDigits = row.phone.replace(/\D/g, "");

    if (!row.phone.trim()) {
      add("phone", "Write the phone number.");
    } else if (phoneDigits.length < 7 || phoneDigits.length > 15) {
      add("phone", "This phone number looks wrong.");
    } else if (firstLineWithPhone.has(row.phone)) {
      add("phone", `Same phone as line ${firstLineWithPhone.get(row.phone)}.`);
    } else if (context.takenPhones.has(row.phone)) {
      add("phone", `${context.takenPhones.get(row.phone)} already uses this phone in this hostel.`);
    } else {
      firstLineWithPhone.set(row.phone, line);
    }

    const email = row.email.trim().toLowerCase();

    if (email) {
      if (!EMAIL.test(email)) {
        add("email", "This email looks wrong.");
      } else if (firstLineWithEmail.has(email)) {
        add("email", `Same email as line ${firstLineWithEmail.get(email)}.`);
      } else if (context.takenEmails.has(email)) {
        add("email", `${context.takenEmails.get(email)} already uses this email in this hostel.`);
      } else if (context.livingElsewhere.has(email)) {
        add(
          "email",
          `This person is already living in ${context.livingElsewhere.get(email)}. They must move out there first.`,
        );
      } else {
        firstLineWithEmail.set(email, line);
      }
    }

    const room = context.roomTypes.find((candidate) => sameRoomType(candidate.roomType, row.roomType));

    if (!row.roomType.trim()) {
      add("roomType", "Choose a room type.");
    } else if (!room) {
      add("roomType", `"${row.roomType}" is not a room type in this hostel.`);
    } else {
      summaries.get(room.roomType.toLowerCase())!.inList += 1;
    }

    if (!row.paidTill) {
      add("paidTill", "Choose if this month's rent is paid, or how many months are due.");
    } else if (row.paidTill < oldest) {
      add(
        "paidTill",
        `More than ${MAX_MONTHS_BACK} months due. Put the older money in Old dues.`,
      );
    } else if (row.paidTill > newest) {
      add("paidTill", `Paid more than ${MAX_MONTHS_AHEAD} months ahead. Check the month.`);
    }

    if (row.joinedDate) {
      const joined = new Date(row.joinedDate);

      if (Number.isNaN(joined.getTime()) || joined > bsPeriodBounds(context.currentPeriod).end) {
        add("joinedDate", "Joined date cannot be in the future.");
      }
    }

    // The rate card is the only rent — a typed or uploaded one is never used.
    const rent = room?.monthlyRent ?? null;

    if (room && rent === null) {
      add("monthlyRent", `${room.roomType} has no rent in the rate card. Set it in Fee schedule first.`);
    }

    let bills: BillPreview | null = null;

    if (rent !== null && row.paidTill && !problems.some((problem) => problem.field === "paidTill")) {
      const moveInDate = moveInDateFor(row);
      const months = unpaidMonths(row.paidTill, context.currentPeriod)
        .map((period) => ({
          amount: computeInvoiceAmount(rent, moveInDate, null, period).amount,
          label: monthLabel(period),
          period,
        }))
        .filter((month) => month.amount > 0);

      const first = months[0];

      if (row.partPaid > 0 && !first) {
        add("partPaid", "Nothing is due, so nothing can be part paid.");
      } else if (first && row.partPaid >= first.amount) {
        add(
          "partPaid",
          `Part paid must be less than ${first.label} rent (Rs ${first.amount}). If it is all paid, choose one month fewer.`,
        );
      }

      bills = {
        months,
        oldDues: row.oldDues,
        partPaid: row.partPaid,
        total: months.reduce((sum, month) => sum + month.amount, 0) + row.oldDues - row.partPaid,
      };
    }

    return { added: false, bills, id: row.id, problems, rent };
  });

  for (const summary of summaries.values()) {
    if (summary.inList > summary.freeBeds) {
      listProblems.push(
        `${summary.roomType} has ${summary.freeBeds} free ${summary.freeBeds === 1 ? "bed" : "beds"} but ${summary.inList} residents in this list. Change the beds in Rooms first.`,
      );
    }
  }

  const toAdd = checked.filter((row) => !row.added).length;
  const withProblems = checked.filter((row) => row.problems.length > 0).length;

  return {
    listProblems,
    ready: toAdd > 0 && withProblems === 0 && listProblems.length === 0,
    roomTypes: [...summaries.values()].filter((summary) => summary.inList > 0),
    rows: checked,
    toAdd,
    withProblems,
  };
}
