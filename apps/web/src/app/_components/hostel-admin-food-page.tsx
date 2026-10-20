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
} from "@/app/_components/shared-ui";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MEAL_TIMING_DEFAULTS } from "@hostel/shared/food/meal-window";
import { browserApi } from "@/lib/browser-api";
import { hostelAdminEndpoints } from "@/lib/hostel-admin-endpoints";
import { useInvalidateResources, usePortalResource } from "@/lib/portal-query";
import { cn } from "@/lib/utils";

import { HostelAdminCooksPanel } from "./hostel-admin-cooks-panel";
import { field, optionalField, PageHeader } from "./hostel-admin-shared";
import { Chip } from "./hostel-admin-page-ui";

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

    if (!hasRoutine) {
      return (
        <Panel>
          <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
            <span className="rounded-full bg-role-team-soft p-4 text-role-team">
              <ChefHat className="size-8" />
            </span>
            <p className="font-heading text-[15px] font-bold text-foreground">
              No food routine yet
            </p>
            <p className="max-w-md text-[13.5px] text-muted-foreground">
              Set it once — it repeats every week until you change it.
            </p>
          </div>
        </Panel>
      );
    }

    return (
      <Panel>
        <div className="flex gap-1 rounded-xl bg-muted p-1 sm:w-fit">
          {TABS.map((entry) => (
            <button
              className={cn(
                "flex flex-1 items-center justify-center gap-2 rounded-lg px-3.5 py-1.5 text-[12.5px] font-semibold transition",
                tab === entry.id
                  ? "bg-card text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
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
          <div className="mt-4 overflow-x-auto">
            <div className="grid min-w-[860px] grid-cols-[110px_repeat(4,minmax(0,1fr))] gap-2">
              <span />
              {MEALS.map((meal) => (
                <div className="flex items-center gap-2 px-1 pb-1" key={meal.type}>
                  <span className="flex size-8 items-center justify-center rounded-full bg-role-team-soft text-role-team">
                    <meal.icon className="size-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-semibold text-foreground">{meal.label}</span>
                    <span className="block text-[11px] text-muted-foreground">
                      {routine?.timings?.[meal.type] || meal.defaultTiming}
                    </span>
                  </span>
                </div>
              ))}
              {DAYS.map((day) => (
                <div className="contents" key={day}>
                  <div className="flex items-center px-1 text-[12px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
                    {titleCase(day).slice(0, 3)}
                  </div>
                  {MEALS.map((meal) => {
                    const cell = cells.get(`${day}:${meal.type}`);

                    return (
                      <div
                        className={cn(
                          "min-h-14 rounded-xl p-2.5 text-[13px]",
                          cell ? "bg-muted/60 text-foreground" : "border border-dashed border-border text-muted-foreground",
                        )}
                        key={meal.type}
                      >
                        {cell ? (
                          <>
                            <span className="line-clamp-2">{cell.items.join(", ")}</span>
                            {cell.note ? (
                              <span className="mt-1 inline-flex items-center gap-1 text-[11px] font-semibold text-role-team">
                                <Sparkles className="size-3" />
                                {cell.note}
                              </span>
                            ) : null}
                          </>
                        ) : (
                          "—"
                        )}
                      </div>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {tab === "special" ? (
          <div className="mt-4">
            {notedMeals.length === 0 ? (
              <EmptyState label="No special foods noted yet. Add a note to a meal in the routine." />
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {notedMeals.map((meal) => (
                  <div
                    className="space-y-2 rounded-2xl border border-border/70 p-3.5"
                    key={`${meal.dayOfWeek}:${meal.mealType}`}
                  >
                    <p className="text-[13.5px] font-semibold text-foreground">{meal.items.join(", ")}</p>
                    <p className="text-[12.5px] text-muted-foreground">{meal.note}</p>
                    <div className="flex flex-wrap gap-1.5">
                      <Chip glyph="restaurant" tone="brand">{titleCase(meal.mealType)}</Chip>
                      <Chip glyph="calendar">{`Every ${titleCase(meal.dayOfWeek)}`}</Chip>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {tab === "month-end" ? (
          <div className="mt-4">
            {monthEndSpecial ? (
              <div className="flex items-start gap-3 rounded-2xl border border-border/70 p-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-role-team-soft text-role-team">
                  <ChefHat className="size-5" />
                </span>
                <div>
                  <p className="font-heading text-[15px] font-bold text-foreground">
                    {monthEndSpecial.items.join(", ")}
                  </p>
                  <p className="text-[12.5px] text-muted-foreground">
                    Last day of every month{monthEndSpecial.note ? ` · ${monthEndSpecial.note}` : ""}
                  </p>
                </div>
              </div>
            ) : (
              <EmptyState label="No month end special set." />
            )}
          </div>
        ) : null}
      </Panel>
    );
  }

  const routineEditor = (
    <Dialog onOpenChange={setIsEditing} open={isEditing}>
      <DialogContent className="sm:max-w-6xl">
        <DialogHeader>
          <DialogTitle>Food routine</DialogTitle>
          <DialogDescription>Repeats every week. Leave a meal blank to skip it.</DialogDescription>
        </DialogHeader>
          <form className="grid gap-5" onSubmit={handleSaveRoutine}>
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

            {/* Stored on its own, so it never replaces that day's dinner. */}
            <div className="grid gap-3 rounded-xl bg-muted/50 p-4">
              <div>
                <p className="font-heading text-[13.5px] font-bold text-foreground">
                  Month End Special
                </p>
                <p className="text-[12px] text-muted-foreground">
                  An extra on the last day of every month. Blank removes it.
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

            <DialogFooter>
              <Button
                className="h-10 rounded-xl bg-brand-teal px-5 text-white hover:bg-brand-teal/90"
                loading={busyForm === "routine"}
                type="submit"
              >
                Save food routine
              </Button>
            </DialogFooter>
          </form>
      </DialogContent>
    </Dialog>
  );

  return (
    <div className="mx-auto max-w-[1448px] space-y-5">
      <PageHeader
        action={
          state === "ready" ? (
            <Button
              className="h-9 gap-2 rounded-xl bg-brand-teal px-3.5 text-white hover:bg-brand-teal/90"
              onClick={() => setIsEditing(true)}
              type="button"
            >
              {hasRoutine ? <Pencil className="size-4" /> : <Plus className="size-4" />}
              {hasRoutine ? "Edit routine" : "Set routine"}
            </Button>
          ) : undefined
        }
        description="The weekly menu residents see, and who cooks it."
        icon={ChefHat}
        title="Food"
      />
      {message ? (
        <div className="rounded-xl border border-border bg-muted/40 px-4 py-3 text-[13.5px]">
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
      {routineEditor}
    </div>
  );
});
