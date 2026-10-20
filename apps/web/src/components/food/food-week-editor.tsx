"use client";

import { MEAL_TIMING_DEFAULTS } from "@hostel/shared/food/meal-window";
import {
  MEAL_TYPES,
  type MealType,
  ROUTINE_DAYS,
  type RoutineDay,
  sampleWeekCells,
} from "@hostel/shared/food/sample-week";
import { useMemo, useState } from "react";

import { useConfirm } from "@/app/_components/confirm-dialog";
import { Copy, RotateCcw, Sparkles } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { cn } from "@/lib/utils";

export type FoodRoutineView = {
  meals: { dayOfWeek: RoutineDay; items: string[]; mealType: MealType; note?: string | null }[];
  monthEndSpecial: { items: string[]; note: string } | null;
  timings: Partial<Record<MealType, string>>;
};

const MEAL_LABELS: Record<MealType, string> = {
  BREAKFAST: "Breakfast",
  DINNER: "Dinner",
  LUNCH: "Lunch",
  SNACKS: "Snacks",
};

const DAY_SHORT: Record<RoutineDay, string> = {
  FRIDAY: "Fri",
  MONDAY: "Mon",
  SATURDAY: "Sat",
  SUNDAY: "Sun",
  THURSDAY: "Thu",
  TUESDAY: "Tue",
  WEDNESDAY: "Wed",
};

const key = (day: RoutineDay, meal: MealType) => `${day}:${meal}`;

function splitItems(value: string) {
  return value
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

/**
 * The weekly menu, one day at a time — the app's editor on the web. Meal times
 * are set once at the top, not on every meal. A hostel with no menu yet opens
 * on the sample week (`SAMPLE_WEEK`), which is only kept if they save it.
 *
 * Fill with sample, copy one day onto others, and clear all are the three
 * shortcuts; nothing reaches residents until Save.
 */
export function FoodWeekEditor({
  onSaved,
  routine,
}: {
  onSaved?: () => void | Promise<void>;
  routine: FoodRoutineView | null;
}) {
  const saved = useMemo(() => {
    const cells: Record<string, string> = {};

    for (const meal of routine?.meals ?? []) {
      cells[key(meal.dayOfWeek, meal.mealType)] = meal.items.join(", ");
    }

    return cells;
  }, [routine]);
  const empty = Object.keys(saved).length === 0;
  const [cells, setCells] = useState<Record<string, string>>(() => (empty ? sampleWeekCells() : saved));
  const [timings, setTimings] = useState<Record<MealType, string>>(() => ({
    ...MEAL_TIMING_DEFAULTS,
    ...Object.fromEntries(Object.entries(routine?.timings ?? {}).filter(([, value]) => value)),
  }));
  const [day, setDay] = useState<RoutineDay>("SUNDAY");
  const [copyTo, setCopyTo] = useState<RoutineDay[]>([]);
  const [copying, setCopying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState(empty ? "Sample menu — change anything, then save." : "");
  const { confirm, confirmDialog } = useConfirm();

  const filledDays = useMemo(
    () => new Set(ROUTINE_DAYS.filter((item) => MEAL_TYPES.some((meal) => (cells[key(item, meal)] ?? "").trim()))),
    [cells],
  );

  function copyDay() {
    setCells((current) => {
      const next = { ...current };

      for (const target of copyTo) {
        for (const meal of MEAL_TYPES) next[key(target, meal)] = current[key(day, meal)] ?? "";
      }

      return next;
    });
    setNote(`Copied ${DAY_SHORT[day]} onto ${copyTo.map((item) => DAY_SHORT[item]).join(", ")}. Save to keep it.`);
    setCopyTo([]);
    setCopying(false);
  }

  async function save() {
    const meals = ROUTINE_DAYS.flatMap((dayOfWeek) =>
      MEAL_TYPES.flatMap((mealType) => {
        const items = splitItems(cells[key(dayOfWeek, mealType)] ?? "");
        return items.length ? [{ dayOfWeek, items, mealType }] : [];
      }),
    );

    if (meals.length === 0) {
      setError("Add at least one meal.");
      return;
    }

    setBusy(true);
    setError("");

    try {
      await browserApi(hostelAdminEndpoints.foodRoutine, {
        body: JSON.stringify({
          meals,
          // Untouched here; the Food screen edits it.
          monthEndSpecial: {
            items: routine?.monthEndSpecial?.items ?? [],
            note: routine?.monthEndSpecial?.note || undefined,
          },
          timings,
        }),
        method: "PUT",
      });
      setNote("Saved. Residents and the cook see it now.");
      await onSaved?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The menu did not save.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {confirmDialog}

      <div className="flex flex-wrap gap-2">
        <Button
          onClick={async () => {
            if (
              !empty &&
              !(await confirm({
                actionLabel: "Fill",
                description: "Every meal is replaced by the sample menu. Nothing is saved until you press Save.",
                title: "Fill with the sample menu?",
              }))
            )
              return;
            setCells(sampleWeekCells());
            setNote("Sample menu filled in — change anything, then save.");
          }}
          size="sm"
          type="button"
          variant="outline"
        >
          <Sparkles className="size-3.5" />
          Fill with sample
        </Button>
        <Button onClick={() => setCopying((value) => !value)} size="sm" type="button" variant="outline">
          <Copy className="size-3.5" />
          Copy {DAY_SHORT[day]} to…
        </Button>
        <Button
          onClick={async () => {
            if (
              !(await confirm({
                actionLabel: "Clear all",
                description: "Every meal on every day is emptied. Nothing is saved until you press Save.",
                title: "Clear the whole menu?",
                tone: "destructive",
              }))
            )
              return;
            setCells({});
            setNote("Cleared. Type the menu, or fill with the sample.");
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          <RotateCcw className="size-3.5" />
          Reset all
        </Button>
      </div>

      {copying ? (
        <div className="space-y-2 rounded-xl border border-border p-3">
          <p className="text-xs font-semibold text-foreground">Copy {DAY_SHORT[day]}&apos;s meals onto</p>
          <div className="flex flex-wrap gap-1.5">
            {ROUTINE_DAYS.filter((item) => item !== day).map((item) => {
              const on = copyTo.includes(item);

              return (
                <button
                  className={cn(
                    "h-8 rounded-full border px-3 text-xs font-semibold transition",
                    on ? "border-brand-teal bg-brand-teal text-white" : "border-border text-foreground hover:bg-muted",
                  )}
                  key={item}
                  onClick={() => setCopyTo((current) => (on ? current.filter((value) => value !== item) : [...current, item]))}
                  type="button"
                >
                  {DAY_SHORT[item]}
                </button>
              );
            })}
            <button
              className="h-8 rounded-full px-3 text-xs font-semibold text-brand-teal hover:bg-muted"
              onClick={() => setCopyTo(ROUTINE_DAYS.filter((item) => item !== day))}
              type="button"
            >
              All days
            </button>
          </div>
          <Button disabled={copyTo.length === 0} onClick={copyDay} size="sm" type="button">
            Copy
          </Button>
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {MEAL_TYPES.map((meal) => (
          <label className="grid gap-1 text-xs font-semibold text-muted-foreground" key={meal}>
            {MEAL_LABELS[meal]} time
            <input
              className="h-9 rounded-lg border border-border bg-background px-2.5 text-sm font-normal text-foreground outline-none focus:border-primary"
              onChange={(event) => setTimings((current) => ({ ...current, [meal]: event.target.value }))}
              placeholder="7:00 AM - 8:00 AM"
              value={timings[meal] ?? ""}
            />
          </label>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1 rounded-xl bg-muted p-1">
        {ROUTINE_DAYS.map((item) => (
          <button
            className={cn(
              "relative h-9 rounded-lg text-xs font-semibold transition",
              item === day ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground",
            )}
            key={item}
            onClick={() => {
              setDay(item);
              setCopyTo([]);
            }}
            type="button"
          >
            {DAY_SHORT[item]}
            {filledDays.has(item) ? (
              <span className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-brand-teal" />
            ) : null}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        {MEAL_TYPES.map((meal) => (
          <label className="grid gap-1 text-sm font-semibold text-foreground" key={meal}>
            <span className="flex items-baseline justify-between gap-2">
              {MEAL_LABELS[meal]}
              <span className="text-xs font-normal text-muted-foreground">{timings[meal]}</span>
            </span>
            <input
              className="h-10 rounded-lg border border-border bg-background px-3 text-sm font-normal outline-none focus:border-primary"
              onChange={(event) => setCells((current) => ({ ...current, [key(day, meal)]: event.target.value }))}
              placeholder="Dal, Bhat, Tarkari"
              value={cells[key(day, meal)] ?? ""}
            />
          </label>
        ))}
      </div>

      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      <Button className="h-11 w-full" disabled={busy} onClick={() => void save()} type="button">
        {busy ? "Saving…" : "Save menu"}
      </Button>
    </div>
  );
}
