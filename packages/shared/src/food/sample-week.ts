/**
 * The starting menu a hostel sees before it has saved its own — the same week
 * the team registration pre-fills, kept in one place so the website, the KYC
 * and the Food screen never offer three different "samples". Nothing here is
 * saved until the owner presses Save.
 */

export const MEAL_TYPES = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"] as const;
export type MealType = (typeof MEAL_TYPES)[number];

/** Sunday first: Nepal's week starts on Sunday. */
export const ROUTINE_DAYS = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;
export type RoutineDay = (typeof ROUTINE_DAYS)[number];

export const SAMPLE_WEEK: Record<RoutineDay, Record<MealType, string>> = {
  SUNDAY: {
    BREAKFAST: "Roti, Aloo Tarkari, Tea",
    LUNCH: "Dal, Bhat, Tarkari, Achar",
    SNACKS: "Chiura, Tea",
    DINNER: "Dal, Bhat, Tarkari",
  },
  MONDAY: {
    BREAKFAST: "Bread, Jam, Tea",
    LUNCH: "Dal, Bhat, Tarkari, Achar",
    SNACKS: "Biscuit, Tea",
    DINNER: "Dal, Bhat, Saag",
  },
  TUESDAY: {
    BREAKFAST: "Roti, Tarkari, Tea",
    LUNCH: "Dal, Bhat, Tarkari",
    SNACKS: "Chana, Tea",
    DINNER: "Dal, Bhat, Tarkari, Achar",
  },
  WEDNESDAY: {
    BREAKFAST: "Paratha, Tea",
    LUNCH: "Dal, Bhat, Tarkari, Achar",
    SNACKS: "Chiura, Tea",
    DINNER: "Dal, Bhat, Anda Curry",
  },
  THURSDAY: {
    BREAKFAST: "Roti, Aloo Tarkari, Tea",
    LUNCH: "Dal, Bhat, Tarkari",
    SNACKS: "Chowmein, Tea",
    DINNER: "Dal, Bhat, Saag",
  },
  FRIDAY: {
    BREAKFAST: "Bread, Anda, Tea",
    LUNCH: "Dal, Bhat, Tarkari, Achar",
    SNACKS: "Chiura, Tea",
    DINNER: "Dal, Bhat, Masu",
  },
  SATURDAY: {
    BREAKFAST: "Puri, Tarkari, Tea",
    LUNCH: "Dal, Bhat, Tarkari, Achar",
    SNACKS: "Sel Roti, Tea",
    DINNER: "Dal, Bhat, Tarkari",
  },
};

/** The sample as flat `DAY:MEAL` cells, the shape the editors work in. */
export function sampleWeekCells(): Record<string, string> {
  const cells: Record<string, string> = {};

  for (const day of ROUTINE_DAYS) {
    for (const meal of MEAL_TYPES) {
      cells[`${day}:${meal}`] = SAMPLE_WEEK[day][meal];
    }
  }

  return cells;
}
