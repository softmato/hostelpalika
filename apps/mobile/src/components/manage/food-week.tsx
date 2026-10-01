import { useCallback, useMemo, useRef, useState } from "react";

import { useResource } from "@/hooks/use-resource";
import { saveFoodRoutine } from "@/lib/admin-manage-api";
import { type AdminFoodData, adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { cellKey, draftFrom, foodPayload, splitItems, type FoodDraft, type MealDraft } from "@/lib/food-draft";
import { MEAL_TYPES, type MealType, ROUTINE_DAYS, type RoutineDay, todayInNepal } from "@/lib/food-week";
import { toastError, toastSuccess } from "@/lib/toast";

/**
 * The weekly menu as a draft — Food and Hostel KYC's "Weekly food" step both
 * edit it through this.
 *
 * ## One document, one save
 *
 * `PUT /hostel-admin/food/routine` replaces the whole routine. There is no
 * per-cell write, so this holds a **draft** and only touches the network when
 * Save is pressed — which also means an accidental tap on the wrong day costs
 * nothing.
 */

export { splitItems } from "@/lib/food-draft";
export type { FoodDraft } from "@/lib/food-draft";

/** `onSaved` runs after the week is written — KYC re-reads its ticks from it. */
export function useFoodWeek({ onSaved }: { onSaved?: () => void } = {}) {
  const query = adminQuery.food();
  const food = useResource<AdminFoodData>(query.load, {
    cacheKey: query.key,
    topics: query.topics,
  });

  const [day, setDay] = useState<RoutineDay>(() => todayInNepal());
  const [draft, setDraft] = useState<FoodDraft | null>(null);
  const [editing, setEditing] = useState<MealType | null>(null);
  const [saving, setSaving] = useState(false);
  const saveLock = useRef(false);

  const loaded = useMemo(() => draftFrom(food.data?.routine ?? null), [food.data]);
  const current = draft ?? loaded;
  // Compared as what would be sent, so typing a letter and deleting it is not an edit.
  const dirty = draft !== null && JSON.stringify(foodPayload(draft)) !== JSON.stringify(foodPayload(loaded));

  const setCell = useCallback(
    (mealType: MealType, next: MealDraft) => {
      setDraft((prev) => {
        const base = prev ?? loaded;

        return { ...base, meals: { ...base.meals, [cellKey(day, mealType)]: next } };
      });
    },
    [day, loaded],
  );

  const save = useCallback(async () => {
    if (saveLock.current) return false;
    saveLock.current = true;
    setSaving(true);
    try {
      const payload = foodPayload(current);
      await saveFoodRoutine(payload);
      // Written locally first: `refresh()` does not wait, and dropping the draft
      // onto the old routine would flash last week's menu until it lands.
      food.setData((previous) => previous ? { ...previous, routine: {
        meals: payload.meals.map((meal) => ({ ...meal, note: meal.note ?? "", timing: payload.timings[meal.mealType] ?? "" })),
        monthEndSpecial: payload.monthEndSpecial.items.length ? { items: payload.monthEndSpecial.items, note: payload.monthEndSpecial.note ?? "" } : null,
        timings: payload.timings,
        updatedAt: new Date().toISOString(),
      } } : previous);
      toastSuccess("Menu saved", "Residents and the cook see it immediately.");
      setDraft(null);
      food.refresh();
      onSaved?.();
      return true;
    } catch (error) {
      toastError("Could not save", readApiError(error, "The menu did not save."));
      return false;
    } finally {
      saveLock.current = false;
      setSaving(false);
    }
  }, [current, food, onSaved]);

  const filled = ROUTINE_DAYS.reduce(
    (sum, routineDay) =>
      sum +
      MEAL_TYPES.filter(
        (mealType) => splitItems(current.meals[cellKey(routineDay, mealType)]?.items ?? "").length > 0,
      ).length,
    0,
  );

  return {
    cells: ROUTINE_DAYS.length * MEAL_TYPES.length,
    current,
    day,
    dirty,
    editing,
    filled,
    food,
    loaded,
    save,
    saving,
    setCell,
    setDay,
    setDraft,
    setEditing,
  };
}

export type FoodWeek = ReturnType<typeof useFoodWeek>;
