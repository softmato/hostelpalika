"use client";

import {
  CalendarDays,
  ChefHat,
  Cookie,
  Moon,
  Pencil,
  Plus,
  Sparkles,
  Sun,
  Utensils,
  type IconComponent,
} from "@/components/icons";
import { memo, useCallback, useMemo, useState, type FormEvent } from "react";

import {
  EmptyState,
  Input,
  LoadingRows,
  Panel,
  StatusBadge,
} from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import { MEAL_TIMING_DEFAULTS } from "@hostel/shared/food/meal-window";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";

import { HostelAdminCooksPanel } from "./hostel-admin-cooks-panel";
import { field, optionalField, PageHeader } from "./hostel-admin-shared";

type MealType = "BREAKFAST" | "LUNCH" | "SNACKS" | "DINNER";
type DayOfWeek =
  | "SUNDAY"
  | "MONDAY"
  | "TUESDAY"
  | "WEDNESDAY"
  | "THURSDAY"
  | "FRIDAY"
  | "SATURDAY";
type RoutineTab = "month-end" | "special" | "weekly";

type RoutineMeal = {
  dayOfWeek: DayOfWeek;
  items: string[];
  mealType: MealType;
  note: string;
  timing: string;
};

type FoodRoutine = {
  meals: RoutineMeal[];
  monthEndSpecial: { items: string[]; note: string } | null;
  timings: Partial<Record<MealType, string>>;
};


/** Sunday-first: Nepal's week starts on Sunday. */
const DAYS: DayOfWeek[] = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
];

const MEALS: {
  defaultTiming: string;
  icon: IconComponent;
  label: string;
  type: MealType;
}[] = [
  {
    defaultTiming: MEAL_TIMING_DEFAULTS.BREAKFAST,
    icon: Sun,
    label: "Breakfast (Morning)",
    type: "BREAKFAST",
  },
  {
    defaultTiming: MEAL_TIMING_DEFAULTS.LUNCH,
    icon: Utensils,
    label: "Lunch",
    type: "LUNCH",
  },
  {
    defaultTiming: MEAL_TIMING_DEFAULTS.SNACKS,
    icon: Cookie,
    label: "Evening Snacks",
    type: "SNACKS",
  },
  {
    defaultTiming: MEAL_TIMING_DEFAULTS.DINNER,
    icon: Moon,
    label: "Dinner",
    type: "DINNER",
  },
];

const TABS: { icon: IconComponent; id: RoutineTab; label: string }[] = [
  { icon: CalendarDays, id: "weekly", label: "Weekly Routine" },
  { icon: Sparkles, id: "special", label: "Special Foods" },
  { icon: ChefHat, id: "month-end", label: "Month End Special" },
];

function titleCase(value: string) {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

function splitItems(value: FormDataEntryValue | null) {
  return (
    value
      ?.toString()
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean) ?? []
  );
}

export const HostelAdminFoodPage = memo(function HostelAdminFoodPage() {
  const [actionMessage, setActionMessage] = useState("");
  const [busyForm, setBusyForm] = useState<"" | "routine">("");
  const [tab, setTab] = useState<RoutineTab>("weekly");
  const [isEditing, setIsEditing] = useState(false);
  const invalidate = useInvalidateResources();

  // One routine per hostel, no week to pick: it repeats until it is changed.
  const routineResource = usePortalResource<{ routine: FoodRoutine }>(
    hostelAdminEndpoints.foodRoutine,
    { errorMessage: "Could not load the food routine." },
  );

  const routine = routineResource.data?.routine;
  const state = routineResource.state;
  const message = actionMessage || routineResource.message;

  // (day, meal) -> meal, so the grid and the editor both read a cell by key.
  const cells = useMemo(() => {
    const map = new Map<string, RoutineMeal>();

    for (const meal of routine?.meals ?? []) {
      map.set(`${meal.dayOfWeek}:${meal.mealType}`, meal);
    }

    return map;
  }, [routine]);

  const notedMeals = useMemo(
    () => (routine?.meals ?? []).filter((meal) => Boolean(meal.note)),
    [routine],
  );
  const monthEndSpecial = routine?.monthEndSpecial ?? null;
  const hasRoutine = cells.size > 0;


  /**
   * The routine is one document, so saving it is one PUT that replaces it.
   * A cleared cell is simply absent from `meals`.
   */
  const handleSaveRoutine = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const meals = [];

      for (const day of DAYS) {
        for (const meal of MEALS) {
          const items = splitItems(form.get(`items:${day}:${meal.type}`));

          if (items.length === 0) {
            continue;
          }

          meals.push({
            dayOfWeek: day,
            items,
            mealType: meal.type,
            note: optionalField(form, `note:${day}:${meal.type}`),
          });
        }
      }

      setBusyForm("routine");
      try {
        await browserApi(hostelAdminEndpoints.foodRoutine, {
          body: JSON.stringify({
            meals,
            monthEndSpecial: {
              items: splitItems(form.get("monthEndItems")),
              note: optionalField(form, "monthEndNote"),
            },
            timings: Object.fromEntries(
              MEALS.map((meal) => [meal.type, field(form, `timing:${meal.type}`)]),
            ),
          }),
          method: "PUT",
        });

        setActionMessage("Food routine saved.");
        setIsEditing(false);
        invalidate(hostelAdminEndpoints.foodRoutine);
      } catch (error) {
        setActionMessage(
          error instanceof Error ? error.message : "Could not save the food routine.",
        );
      } finally {
        setBusyForm("");
      }
    },
    [invalidate],
  );

  const editButton =
    hasRoutine && !isEditing ? (
      <button
        className="flex h-11 items-center gap-2 rounded-md border border-role-admin px-4 text-sm font-semibold text-role-admin hover:bg-role-admin/10"
        onClick={() => setIsEditing(true)}
        type="button"
      >
        <Pencil className="size-4" />
        Edit Routine
      </button>
    ) : null;

  function renderRoutineCard() {
    if (state === "loading") {
      return (
        <Panel>
          <LoadingRows />
        </Panel>
      );
    }

    if (state === "error") {
      return (
        <Panel>
          <EmptyState label="The food routine could not be loaded." />
        </Panel>
      );
    }

    if (isEditing) {
      return (
        <Panel>
          <div>
            <h2 className="font-heading text-lg font-bold text-foreground">
              Configure Food Routine
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              This routine repeats every week. Leave a meal blank to skip it.
            </p>
          </div>
          <form className="mt-5 grid gap-5" onSubmit={handleSaveRoutine}>
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {MEALS.map((meal) => (
                <Input
                  defaultValue={routine?.timings?.[meal.type] || meal.defaultTiming}
                  key={meal.type}
                  label={`${meal.label} timing`}
                  name={`timing:${meal.type}`}
                  required
                />
              ))}
            </div>

            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[900px] border-collapse text-sm">
                <thead>
                  <tr className="bg-muted/50 text-left">
                    <th className="w-32 px-4 py-3 font-semibold text-foreground">Day</th>
                    {MEALS.map((meal) => (
                      <th
                        className="px-4 py-3 font-semibold text-foreground"
                        key={meal.type}
                      >
                        <span className="flex items-center gap-2">
                          <meal.icon className="size-4 text-role-admin" />
                          {meal.label}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {DAYS.map((day) => (
                    <tr className="border-t border-border align-top" key={day}>
                      <td className="px-4 py-3 font-semibold text-foreground">
                        {titleCase(day)}
                      </td>
                      {MEALS.map((meal) => {
                        const cell = cells.get(`${day}:${meal.type}`);

                        return (
                          <td className="px-3 py-3" key={meal.type}>
                            <input
                              aria-label={`${day} ${meal.type} items`}
                              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-role-admin"
                              defaultValue={cell?.items.join(", ") ?? ""}
                              name={`items:${day}:${meal.type}`}
                              placeholder="Comma separated items"
                            />
                            <input
                              aria-label={`${day} ${meal.type} note`}
                              className="mt-2 h-9 w-full rounded-md border border-dashed border-border bg-background px-3 text-xs outline-none focus:border-role-admin"
                              defaultValue={cell?.note ?? ""}
                              name={`note:${day}:${meal.type}`}
                              placeholder="Special note (optional)"
                            />
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="grid gap-3 rounded-lg border border-border bg-muted/30 p-4">
              <div>
                <p className="font-heading text-sm font-bold text-foreground">
                  Month End Special
                </p>
                <p className="text-xs text-muted-foreground">
                  An optional extra served on the last day of every month. It is stored on
                  its own, so it never replaces that day&apos;s dinner. Leave it blank to
                  remove it.
                </p>
              </div>
              <div className="grid gap-3 md:grid-cols-2">
                <input
                  className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-role-admin"
                  aria-label="Month-end special items"
                  defaultValue={monthEndSpecial?.items.join(", ") ?? ""}
                  name="monthEndItems"
                  placeholder="Comma separated items"
                />
                <input
                  className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-role-admin"
                  aria-label="Month-end special note"
                  defaultValue={monthEndSpecial?.note ?? ""}
                  name="monthEndNote"
                  placeholder="Note (optional)"
                />
              </div>
            </div>

            <div className="flex flex-wrap gap-3">
              <Button
                className="h-11 bg-role-admin px-6 text-sm font-semibold text-white hover:bg-role-admin/85"
                loading={busyForm === "routine"}
                type="submit"
              >
                Save Food Routine
              </Button>
              <button
                className="h-11 rounded-md border border-border px-6 text-sm font-semibold text-foreground hover:bg-muted/50"
                onClick={() => setIsEditing(false)}
                type="button"
              >
                Cancel
              </button>
            </div>
          </form>
        </Panel>
      );
    }

    if (!hasRoutine) {
      return (
        <Panel>
          <div>
            <h2 className="font-heading text-lg font-bold text-foreground">
              Food &amp; Menu
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Plan and manage the weekly food routine for residents.
            </p>
          </div>
          <div className="mt-6 flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-6 py-14 text-center">
            <span className="rounded-full bg-role-admin-soft p-4 text-role-admin">
              <ChefHat className="size-8" />
            </span>
            <p className="font-heading text-lg font-bold text-foreground">
              No food routine configured
            </p>
            <p className="max-w-md text-sm text-muted-foreground">
              Set the weekly routine once — it repeats every week until you change it.
            </p>
            <Button
              className="mt-2 h-11 bg-role-admin px-6 text-sm font-semibold text-white hover:bg-role-admin/85"
              onClick={() => setIsEditing(true)}
              type="button"
            >
              <Plus className="size-4" />
              Configure Food Routine
            </Button>
          </div>
        </Panel>
      );
    }

    return (
      <Panel>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="font-heading text-lg font-bold text-foreground">
              Food &amp; Menu
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              The weekly routine, repeating every week.
            </p>
          </div>
          {editButton}
        </div>

        <div className="mt-5 flex gap-6 border-b border-border">
          {TABS.map((entry) => (
            <button
              className={cn(
                "-mb-px flex items-center gap-2 border-b-2 pb-3 text-sm font-semibold",
                tab === entry.id
                  ? "border-role-admin text-role-admin"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
              key={entry.id}
              onClick={() => setTab(entry.id)}
              type="button"
            >
              <entry.icon className="size-4" />
              {entry.label}
            </button>
          ))}
        </div>

        {tab === "weekly" ? (
          <div className="mt-5 overflow-x-auto rounded-lg border border-border">
            <table className="w-full min-w-[900px] border-collapse text-sm">
              <thead>
                <tr className="bg-muted/50 text-left">
                  <th className="w-32 px-4 py-3 font-semibold text-foreground">Day</th>
                  {MEALS.map((meal) => (
                    <th
                      className="px-4 py-3 font-semibold text-foreground"
                      key={meal.type}
                    >
                      <span className="flex items-center gap-2">
                        <meal.icon className="size-4 text-role-admin" />
                        {meal.label}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {DAYS.map((day) => (
                  <tr className="border-t border-border align-top" key={day}>
                    <td className="px-4 py-3 font-semibold text-foreground">
                      {titleCase(day)}
                    </td>
                    {MEALS.map((meal) => {
                      const cell = cells.get(`${day}:${meal.type}`);

                      return (
                        <td className="px-4 py-3 text-foreground" key={meal.type}>
                          {cell ? (
                            <>
                              <span>{cell.items.join(", ")}</span>
                              <span className="mt-1 block text-xs text-muted-foreground">
                                {cell.timing}
                              </span>
                            </>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === "special" ? (
          <div className="mt-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-heading text-sm font-bold text-foreground">
                  Special Foods
                </p>
                <p className="text-xs text-muted-foreground">
                  Meals in the routine carrying a note. Clear the note to remove one.
                </p>
              </div>
              <button
                className="flex h-10 items-center gap-2 rounded-md bg-role-admin px-4 text-sm font-semibold text-white hover:bg-role-admin/85"
                onClick={() => setIsEditing(true)}
                type="button"
              >
                <Pencil className="size-4" />
                Edit Routine
              </button>
            </div>
            {notedMeals.length === 0 ? (
              <div className="mt-4">
                <EmptyState label="No special foods noted yet." />
              </div>
            ) : (
              <div className="mt-4 overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[640px] border-collapse text-sm">
                  <thead>
                    <tr className="bg-muted/50 text-left">
                      <th className="px-4 py-3 font-semibold text-foreground">
                        Food Item
                      </th>
                      <th className="px-4 py-3 font-semibold text-foreground">
                        Description / Notes
                      </th>
                      <th className="w-44 px-4 py-3 font-semibold text-foreground">
                        Served
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {notedMeals.map((meal) => (
                      <tr
                        className="border-t border-border"
                        key={`${meal.dayOfWeek}:${meal.mealType}`}
                      >
                        <td className="px-4 py-3 text-foreground">
                          {meal.items.join(", ")}
                        </td>
                        <td className="px-4 py-3 text-muted-foreground">{meal.note}</td>
                        <td className="px-4 py-3">
                          <StatusBadge>{meal.mealType}</StatusBadge>
                          <span className="mt-1 block text-xs text-muted-foreground">
                            Every {titleCase(meal.dayOfWeek)}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}

        {tab === "month-end" ? (
          <div className="mt-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="font-heading text-sm font-bold text-foreground">
                  Month End Special
                </p>
                <p className="text-xs text-muted-foreground">
                  An optional extra served on the last day of every month.
                </p>
              </div>
              <button
                className="flex h-10 items-center gap-2 rounded-md bg-role-admin px-4 text-sm font-semibold text-white hover:bg-role-admin/85"
                onClick={() => setIsEditing(true)}
                type="button"
              >
                <Pencil className="size-4" />
                Edit Routine
              </button>
            </div>
            {monthEndSpecial ? (
              <div className="mt-4 rounded-lg border border-border p-4">
                <p className="font-heading text-base font-bold text-foreground">
                  {monthEndSpecial.items.join(", ")}
                </p>
                {monthEndSpecial.note ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {monthEndSpecial.note}
                  </p>
                ) : null}
              </div>
            ) : (
              <div className="mt-4">
                <EmptyState label="No month end special configured." />
              </div>
            )}
          </div>
        ) : null}
      </Panel>
    );
  }

  return (
    <div className="mx-auto max-w-[1448px] space-y-6">
      <PageHeader
        description="Plan and manage the weekly food routine for residents."
        icon={ChefHat}
        title="Food"
      />
      {message ? (
        <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
          {message}
        </div>
      ) : null}

      {/*
        The roster, not a collapsed credentials drawer.

        Deciding what the kitchen serves and deciding who may say it is ready
        are the same person's decisions, so the section stays on this page — but
        it is now a list with two ways in, a rotation and a removal, and that is
        `HostelAdminCooksPanel`'s job rather than four more pieces of state on
        the menu editor.
      */}
      <HostelAdminCooksPanel />

      {renderRoutineCard()}
    </div>
  );
});
