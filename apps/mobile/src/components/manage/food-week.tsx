import { useCallback, useMemo, useState } from "react";
import { View } from "react-native";

import { DayStrip, MealCard } from "@/components/food-routine";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet } from "@/components/ui/sheet";
import { Text } from "@/components/ui/text";
import { useResource } from "@/hooks/use-resource";
import { saveFoodRoutine } from "@/lib/admin-manage-api";
import { type AdminFoodData, adminQuery } from "@/lib/admin-queries";
import { readApiError } from "@/lib/api-contract";
import { humanizeEnum } from "@/lib/format";
import { MEAL_TYPES, type MealType, ROUTINE_DAYS, type RoutineDay, todayInNepal } from "@/lib/food-week";
import type { FoodRoutine } from "@/lib/resident-api";
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

type MealDraft = { items: string; note: string };

export type FoodDraft = {
  /** Keyed `DAY:MEAL`. Absent means the hostel publishes nothing then. */
  meals: Record<string, MealDraft>;
  monthEndItems: string;
  monthEndNote: string;
  timings: Record<string, string>;
};

const cellKey = (day: RoutineDay, mealType: MealType) => `${day}:${mealType}`;

/** Items are edited as one comma-separated line — that is how a menu is spoken. */
export function splitItems(value: string) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function draftFrom(routine: FoodRoutine | null): FoodDraft {
  const meals: Record<string, MealDraft> = {};

  for (const meal of routine?.meals ?? []) {
    meals[`${meal.dayOfWeek}:${meal.mealType}`] = {
      items: meal.items.join(", "),
      note: meal.note ?? "",
    };
  }

  return {
    meals,
    monthEndItems: routine?.monthEndSpecial?.items.join(", ") ?? "",
    monthEndNote: routine?.monthEndSpecial?.note ?? "",
    timings: { ...(routine?.timings ?? {}) } as Record<string, string>,
  };
}

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

  const loaded = useMemo(() => draftFrom(food.data?.routine ?? null), [food.data]);
  const current = draft ?? loaded;
  const dirty = draft !== null && JSON.stringify(draft) !== JSON.stringify(loaded);

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
    setSaving(true);

    try {
      /*
       * A cell with no items is *omitted*, not sent empty: the server's schema
       * requires `items` to hold at least one entry, so an emptied meal has to
       * disappear from the payload rather than be sent as `[]`. That is also how
       * a meal is cleared — there is no delete call.
       */
      const meals = ROUTINE_DAYS.flatMap((routineDay) =>
        MEAL_TYPES.flatMap((mealType) => {
          const cell = current.meals[cellKey(routineDay, mealType)];
          const items = splitItems(cell?.items ?? "");

          if (items.length === 0) {
            return [];
          }

          return [
            {
              dayOfWeek: routineDay,
              items,
              mealType,
              note: cell?.note?.trim() || undefined,
            },
          ];
        }),
      );

      const monthEndItems = splitItems(current.monthEndItems);

      await saveFoodRoutine({
        meals,
        monthEndSpecial: {
          items: monthEndItems,
          note: current.monthEndNote.trim() || undefined,
        },
        timings: Object.fromEntries(
          MEAL_TYPES.map((mealType) => [mealType, current.timings[mealType]?.trim() ?? ""]).filter(
            ([, value]) => value,
          ),
        ) as Partial<Record<MealType, string>>,
      });

      toastSuccess("Menu saved", "Residents and the cook see it immediately.");
      setDraft(null);
      await food.refresh();
      onSaved?.();
    } catch (error) {
      toastError("Could not save", readApiError(error, "The menu did not save."));
    } finally {
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

/** One day at a time: the day strip, then that day's four meals. */
export function FoodWeekDays({ week }: { week: FoodWeek }) {
  const { current, day, setDay, setEditing } = week;

  return (
    <View className="gap-3">
      <DayStrip active={day} onChange={setDay} today={todayInNepal()} />

      {MEAL_TYPES.map((mealType) => {
        const cell = current.meals[cellKey(day, mealType)];
        const items = splitItems(cell?.items ?? "");

        return (
          <MealCard
            footer={() => (
              <Button
                label={items.length > 0 ? "Edit" : "Add a meal"}
                onPress={() => setEditing(mealType)}
                size="sm"
                variant="outline"
              />
            )}
            items={items}
            key={mealType}
            mealType={mealType}
            note={cell?.note ?? ""}
            timing={current.timings[mealType] ?? ""}
          />
        );
      })}
    </View>
  );
}

export function MealSheet({ week }: { week: FoodWeek }) {
  const { current, day, editing, setCell, setEditing } = week;
  const cell = editing ? current.meals[cellKey(day, editing)] : undefined;

  return (
    <Sheet
      footer={<Button label="Done" onPress={() => setEditing(null)} />}
      onClose={() => setEditing(null)}
      open={editing !== null}
      title={editing ? `${humanizeEnum(day)} — ${humanizeEnum(editing)}` : ""}
    >
      <View className="gap-3 pb-2">
        <Input
          hint="Separate with commas. Empty = no meal."
          label="What is served"
          multiline
          onChangeText={(items) =>
            editing ? setCell(editing, { items, note: cell?.note ?? "" }) : undefined
          }
          placeholder="Dal, bhat, tarkari, achar"
          style={{ height: 96 }}
          value={cell?.items ?? ""}
        />

        <Input
          placeholder="Paneer for the veg table"
          label="Note"
          multiline
          onChangeText={(note) =>
            editing ? setCell(editing, { items: cell?.items ?? "", note }) : undefined
          }
          style={{ height: 80 }}
          value={cell?.note ?? ""}
        />

        <Text variant="caption">Saved when you tap Save the week.</Text>
      </View>
    </Sheet>
  );
}
