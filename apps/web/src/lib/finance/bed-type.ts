import type { BedType } from "@hostel/shared/types/bed-type";

/**
 * Maps a free-text `roomType` onto a canonical {@link BedType} (plan item 1.1).
 *
 * `Resident.roomType` and `Hostel.roomConfigurations[].roomType` are free text —
 * whatever the owner typed — and the product has offered at least three
 * different vocabularies for the same five things. Read out of the development
 * database on 2026-08-06:
 *
 *   residents:            "Single Room", "Four Sharing", "Shared"
 *   roomConfigurations:   "Single Room", "Two Sharing", "Three Sharing",
 *                         "Double Sharing", "Triple Sharing", "Four Sharing",
 *                         "Shared"
 *   hostel.roomTypes:     the above plus "Private"
 *
 * plus `Dormitory` from two pickers, and the `RoomType` enum in the shared
 * package (`ONE_SEATER` … `DORMITORY`) which nothing imports but which will turn
 * up the moment someone wires it in (D1).
 *
 * **Returns `null` rather than guessing.** An unmappable room type must surface
 * as `BED_TYPE_NOT_PRICED` at billing, where a human sees it, instead of being
 * silently rounded to a neighbouring rate. `"Shared"` is the case that matters:
 * it is real data, and it does not say how many people share — two and five are
 * both plausible and the rents differ by thousands. Guessing there bills a real
 * resident the wrong amount every month.
 */

/** Comparison key: case, spacing, and punctuation carry no meaning here. */
function normalizeKey(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const EXACT: Record<string, BedType> = {};

function register(bedType: BedType, ...spellings: string[]) {
  for (const spelling of spellings) {
    EXACT[normalizeKey(spelling)] = bedType;
  }
}

register(
  "SINGLE",
  "Single",
  "Single Room",
  "Single Occupancy",
  "Private",
  "Private Room",
  "One Seater",
  "1 Seater",
  "ONE_SEATER",
);
register(
  "DOUBLE_SHARING",
  "Double",
  "Double Sharing",
  "Double Room",
  "Two Sharing",
  "Twin Sharing",
  "Two Seater",
  "2 Seater",
  "TWO_SEATER",
);
register(
  "TRIPLE_SHARING",
  "Triple",
  "Triple Sharing",
  "Three Sharing",
  "Three Seater",
  "3 Seater",
  "THREE_SEATER",
);
register(
  "FOUR_SHARING",
  "Four Sharing",
  "Four Seater",
  "Quad",
  "Quad Sharing",
  "4 Seater",
  "FOUR_SEATER",
);
register("DORMITORY", "Dormitory", "Dorm", "Dorm Bed", "DORMITORY");

/**
 * "6 Sharing", "5-seater", "8 bed" — a leading count with a sharing word after
 * it. This is arithmetic on what the owner wrote, not inference about what they
 * meant, which is why it is allowed where fuzzy matching is not.
 */
const COUNTED = /^(\d{1,2})(SEATER|SHARING|SHARED|BED|BEDS|PERSON|PAX)$/;

const BY_OCCUPANCY: Record<number, BedType> = {
  1: "SINGLE",
  2: "DOUBLE_SHARING",
  3: "TRIPLE_SHARING",
  4: "FOUR_SHARING",
};

export function normalizeBedType(roomType: string | null | undefined): BedType | null {
  if (!roomType) {
    return null;
  }

  const key = normalizeKey(roomType);

  if (!key) {
    return null;
  }

  const exact = EXACT[key];

  if (exact) {
    return exact;
  }

  const counted = COUNTED.exec(key);

  if (counted) {
    const occupancy = Number(counted[1]);

    if (occupancy >= 5) {
      return "DORMITORY";
    }

    return BY_OCCUPANCY[occupancy] ?? null;
  }

  return null;
}
