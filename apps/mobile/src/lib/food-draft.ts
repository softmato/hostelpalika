import { MEAL_TYPES, ROUTINE_DAYS, type MealType, type RoutineDay } from "@/lib/food-week";
import type { FoodRoutine } from "@/lib/resident-api";

export type MealDraft = { items: string; note: string };
export type FoodDraft = {
  meals: Record<string, MealDraft>;
  monthEndItems: string;
  monthEndNote: string;
  timings: Record<string, string>;
};
export const cellKey = (day: RoutineDay, meal: MealType) => `${day}:${meal}`;
export function splitItems(value: string) {
  return value.split(/[,\n]/).map(item => item.trim()).filter(Boolean).slice(0, 20);
}
export function draftFrom(routine: FoodRoutine | null): FoodDraft {
  return {
    meals: Object.fromEntries((routine?.meals ?? []).map(meal => [cellKey(meal.dayOfWeek, meal.mealType), { items: meal.items.join(", "), note: meal.note ?? "" }])),
    monthEndItems: routine?.monthEndSpecial?.items.join(", ") ?? "",
    monthEndNote: routine?.monthEndSpecial?.note ?? "",
    timings: { ...routine?.timings },
  };
}
/** Copy includes notes and empty meals; neither source nor other days are mutated. */
export function copyMeals(draft: FoodDraft, from: RoutineDay, to: readonly RoutineDay[], onlyMeal?: MealType): FoodDraft {
  const meals = { ...draft.meals };
  for (const day of to.filter(day => day !== from)) {
    for (const meal of onlyMeal ? [onlyMeal] : MEAL_TYPES) {
      meals[cellKey(day, meal)] = { ...(draft.meals[cellKey(from, meal)] ?? { items: "", note: "" }) };
    }
  }
  return { ...draft, meals };
}
export function foodPayload(draft: FoodDraft) {
  return {
    meals: ROUTINE_DAYS.flatMap(dayOfWeek => MEAL_TYPES.flatMap(mealType => {
      const cell = draft.meals[cellKey(dayOfWeek, mealType)];
      const items = splitItems(cell?.items ?? "");
      return items.length ? [{ dayOfWeek, mealType, items, note: cell?.note.trim() || undefined }] : [];
    })),
    monthEndSpecial: { items: splitItems(draft.monthEndItems), note: draft.monthEndNote.trim() || undefined },
    timings: Object.fromEntries(MEAL_TYPES.map(meal => [meal, draft.timings[meal]?.trim() ?? ""])) as Partial<Record<MealType, string>>,
  };
}
