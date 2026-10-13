/**
 * The decisions behind `manage/existing-residents` — which months to offer, how
 * the list groups, what the footer says. Free of React Native so Vitest can hold
 * them; the screen renders what these return.
 */

import { addBsMonths, formatBsPeriod } from "@hostel/calendar/bs";

import type {
  ExistingCheck,
  ExistingCheckedRow,
  ExistingRow,
  ExistingRowInput,
} from "@/lib/existing-residents-api";

/** `Bhadra 2083` — the words on a receipt book, without the era. */
export function monthName(period: string | null | undefined): string {
  if (!period) return "";

  return (formatBsPeriod(period) || period).replace(/\s*BS$/, "");
}

function nameOnly(period: string) {
  return monthName(period).replace(/\s+\d{4}$/, "");
}

/**
 * The rent question as the warden answers it — "paid this month", or "2 months
 * due" — with the month the rent is paid till as the value the server stores.
 * Twelve months back at most (older money is Old dues), two ahead for advance.
 */
export function rentStatusOptions(currentPeriod: string, value?: string | null) {
  const options: { description?: string; label: string; value: string }[] = [
    { description: "Nothing is billed now", label: "Paid this month", value: currentPeriod },
  ];

  for (let due = 1; due <= 12; due += 1) {
    const from = addBsMonths(currentPeriod, 1 - due);

    options.push({
      description:
        due === 1
          ? `${nameOnly(currentPeriod)} is billed`
          : `${nameOnly(from)} to ${nameOnly(currentPeriod)} are billed`,
      label: due === 1 ? "1 month due" : `${due} months due`,
      value: addBsMonths(currentPeriod, -due),
    });
  }

  for (let ahead = 1; ahead <= 2; ahead += 1) {
    const till = addBsMonths(currentPeriod, ahead);

    options.push({
      description: "Paid in advance",
      label: `Paid ahead till ${nameOnly(till)}`,
      value: till,
    });
  }

  if (value && !options.some((option) => option.value === value)) {
    options.push({ label: `Paid till ${monthName(value)}`, value });
  }

  return options;
}

/** `Paid this month`, `2 months due`, `Paid ahead till Kartik`. */
export function rentStatusLabel(paidTill: string | null, currentPeriod: string): string {
  if (!paidTill) {
    return "Rent not set";
  }

  return (
    rentStatusOptions(currentPeriod, paidTill).find((option) => option.value === paidTill)
      ?.label ?? `Paid till ${monthName(paidTill)}`
  );
}

/** Whole rupees from what was typed, or null when nothing was. */
export function rupeesFrom(text: string): number | null {
  const digits = text.replace(/[^\d]/g, "");

  return digits ? Number(digits) : null;
}

export function inputFromRow(row: ExistingRow): ExistingRowInput {
  return {
    depositPaid: row.depositPaid,
    email: row.email,
    fullName: row.fullName,
    id: row.id,
    joinedDate: row.joinedDate,
    monthlyRent: row.monthlyRent,
    oldDues: row.oldDues,
    paidTill: row.paidTill,
    phone: row.phone,
    roomNumber: row.roomNumber ?? "",
    roomType: row.roomType,
  };
}

export function blankRow(): ExistingRowInput {
  return {
    depositPaid: 0,
    email: "",
    fullName: "",
    joinedDate: null,
    monthlyRent: null,
    oldDues: 0,
    // Left for the warden to answer — a default of "paid" is how a resident who
    // owes two months gets added owing nothing.
    paidTill: null,
    phone: "",
    roomNumber: "",
    roomType: "",
  };
}

export type ListSection = {
  rows: { checked: ExistingCheckedRow | null; row: ExistingRow }[];
  title: string;
};

/**
 * Rows by room type, the way a hostel counts its people — with anybody who has
 * a problem pulled to the top of their group, since they are the rows to open.
 */
export function sectionsFor(rows: ExistingRow[], check: ExistingCheck | null): ListSection[] {
  const checkedById = new Map((check?.rows ?? []).map((row) => [row.id, row]));
  const sections = new Map<string, ListSection>();

  for (const row of rows) {
    const title = row.roomType.trim() || "No room type yet";
    const section = sections.get(title.toLowerCase()) ?? { rows: [], title };

    section.rows.push({ checked: checkedById.get(row.id) ?? null, row });
    sections.set(title.toLowerCase(), section);
  }

  const weight = (entry: ListSection["rows"][number]) =>
    entry.row.residentId ? 2 : entry.checked?.problems.length ? 0 : 1;

  return [...sections.values()].map((section) => ({
    ...section,
    rows: [...section.rows].sort((a, b) => weight(a) - weight(b)),
  }));
}

export function listTotals(check: ExistingCheck | null) {
  let months = 0;
  let dues = 0;
  let amount = 0;

  for (const row of check?.rows ?? []) {
    if (!row.bills) continue;

    months += row.bills.months.length;
    dues += row.bills.oldDues > 0 ? 1 : 0;
    amount += row.bills.total;
  }

  return { amount, dues, months };
}

/** One line under a resident's name. */
export function rowSubtitle(
  row: ExistingRow,
  checked: ExistingCheckedRow | null,
  currentPeriod: string,
): string {
  if (row.residentId) {
    return "Added";
  }

  if (checked?.problems.length) {
    return checked.problems[0]!.message;
  }

  return [row.roomNumber ? `Room ${row.roomNumber}` : "", row.phone, rentStatusLabel(row.paidTill, currentPeriod)]
    .filter(Boolean)
    .join(" · ");
}
