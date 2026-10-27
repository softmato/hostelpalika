/**
 * Bed type — the canonical vocabulary for what a resident is renting
 * (target §3.1).
 *
 * **This is not a replacement for `roomType`.** `Resident.roomType` is free text
 * and is the key that hostel capacity accounting matches on by string equality
 * (`hostel-capacity.service.ts`), and the label ~15 screens render. Changing it
 * is a separate project. `bedType` is additive and derived: required on invoices
 * and fee schedules, displayed in finance UI, and authoritative for *pricing*
 * only (plan §3.2, D1).
 *
 * Defined here rather than in the finance module because billing, room
 * configuration and public listings all need the same five words. A private copy
 * inside `modules/finance` is how two vocabularies start disagreeing.
 */
export const BED_TYPES = [
  "SINGLE",
  "DOUBLE_SHARING",
  "TRIPLE_SHARING",
  "FOUR_SHARING",
  "DORMITORY",
] as const;

export type BedType = (typeof BED_TYPES)[number];

/** How many beds share one room. `DORMITORY` is open-ended, hence 5 as a floor. */
export const BED_TYPE_OCCUPANCY: Record<BedType, number> = {
  SINGLE: 1,
  DOUBLE_SHARING: 2,
  TRIPLE_SHARING: 3,
  FOUR_SHARING: 4,
  DORMITORY: 5,
};

/** Display text, the room-type names the owner chose (field review B1); they appear inline in receipts and invoices. */
export const BED_TYPE_LABELS: Record<BedType, string> = {
  SINGLE: "Single Sitter Room",
  DOUBLE_SHARING: "Double Sharing Room",
  TRIPLE_SHARING: "Triple Sharing Room",
  FOUR_SHARING: "Four Sharing Room",
  DORMITORY: "Dormitory",
};

export function isBedType(value: unknown): value is BedType {
  return typeof value === "string" && BED_TYPES.includes(value as BedType);
}

export function bedTypeLabel(value: BedType) {
  return BED_TYPE_LABELS[value];
}
