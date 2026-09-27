import type { Types } from "mongoose";
import type { z } from "zod";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { REALTIME_TOPIC } from "@/lib/realtime/channels";
import { publishResourceChange } from "@/lib/realtime/server";
import { notifyKitchenOfRoutineChange } from "@/modules/food/kitchen-notify";
import { AuditLogModel } from "@hostel/db/models/AuditLog";
import { FoodRoutineModel } from "@hostel/db/models/FoodRoutine";
import { nepalWeekday } from "@hostel/shared/food/meal-window";
import type { foodRoutineSaveSchema } from "@/modules/food/food.validation";

type FoodRoutineSaveInput = z.infer<typeof foodRoutineSaveSchema>;

export const ROUTINE_DAYS = [
  "SUNDAY",
  "MONDAY",
  "TUESDAY",
  "WEDNESDAY",
  "THURSDAY",
  "FRIDAY",
  "SATURDAY",
] as const;

export const ROUTINE_MEAL_TYPES = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"] as const;

export type RoutineDay = (typeof ROUTINE_DAYS)[number];
export type RoutineMealType = (typeof ROUTINE_MEAL_TYPES)[number];

export type RoutineMeal = {
  dayOfWeek: RoutineDay;
  items: string[];
  mealType: RoutineMealType;
  note: string;
  timing: string;
};

export type FoodRoutine = {
  meals: RoutineMeal[];
  monthEndSpecial: { items: string[]; note: string } | null;
  timings: Partial<Record<RoutineMealType, string>>;
  updatedAt: string;
};

type FoodRoutineRecord = {
  meals?: Array<{
    dayOfWeek: RoutineDay;
    items?: string[];
    mealType: RoutineMealType;
    note?: string;
  }>;
  monthEndSpecial?: { items?: string[]; note?: string };
  timings?: Partial<Record<RoutineMealType, string>>;
  updatedAt?: Date;
};

export const EMPTY_ROUTINE: FoodRoutine = {
  meals: [],
  monthEndSpecial: null,
  timings: {},
  updatedAt: "",
};

/**
 * The weekday in Nepal, Sunday-based like the routine. Not `getDay()`: the
 * server runs in UTC, so from midnight to 05:45 in Kathmandu that read
 * yesterday and every dashboard served yesterday's menu.
 */
export function dayOfWeekFor(date: Date): RoutineDay {
  return ROUTINE_DAYS[nepalWeekday(date)];
}

function serializeRoutine(routine: FoodRoutineRecord | null): FoodRoutine {
  if (!routine) {
    return EMPTY_ROUTINE;
  }

  const timings = routine.timings ?? {};
  const monthEnd = routine.monthEndSpecial;

  return {
    meals: (routine.meals ?? [])
      .filter((meal) => (meal.items ?? []).length > 0)
      .map((meal) => ({
        dayOfWeek: meal.dayOfWeek,
        items: meal.items ?? [],
        mealType: meal.mealType,
        note: meal.note ?? "",
        timing: timings[meal.mealType] ?? "",
      })),
    monthEndSpecial:
      monthEnd && (monthEnd.items ?? []).length > 0
        ? { items: monthEnd.items ?? [], note: monthEnd.note ?? "" }
        : null,
    timings,
    updatedAt: routine.updatedAt?.toISOString() ?? "",
  };
}

/**
 * The hostel's routine. Always returns a routine — an unconfigured hostel gets
 * the empty one rather than null, so every caller renders the same shape.
 */
export async function getFoodRoutine(hostelId: Types.ObjectId): Promise<FoodRoutine> {
  await connectToDatabase();

  const routine = await FoodRoutineModel.findOne({
    hostelId,
  }).lean<FoodRoutineRecord | null>();

  return serializeRoutine(routine);
}

/**
 * The routines of many hostels in one query, keyed by hostel id. Hostels
 * without a routine are absent from the map — callers that need the same
 * shape for every hostel fall back to {@link EMPTY_ROUTINE}.
 */
export async function getFoodRoutinesByHostelId(
  hostelIds: Types.ObjectId[],
): Promise<Map<string, FoodRoutine>> {
  const routines = new Map<string, FoodRoutine>();

  if (hostelIds.length === 0) {
    return routines;
  }

  await connectToDatabase();

  const rows = await FoodRoutineModel.find({
    hostelId: { $in: hostelIds },
  }).lean<Array<FoodRoutineRecord & { hostelId: Types.ObjectId }>>();

  for (const row of rows) {
    routines.set(row.hostelId.toString(), serializeRoutine(row));
  }

  return routines;
}

/** The meals served on a given day, in meal order. */
export function mealsOn(routine: FoodRoutine, date: Date): RoutineMeal[] {
  const day = dayOfWeekFor(date);

  return ROUTINE_MEAL_TYPES.map((mealType) =>
    routine.meals.find((meal) => meal.dayOfWeek === day && meal.mealType === mealType),
  ).filter((meal): meal is RoutineMeal => Boolean(meal));
}

/** True when `date` is the last day of its month — when the treat is served. */
export function isMonthEnd(date: Date): boolean {
  const next = new Date(date);

  next.setDate(next.getDate() + 1);
  return next.getDate() === 1;
}

/**
 * Replaces the hostel's routine wholesale — it is one document, so one upsert.
 * Meals left out of the payload are dropped, which is what "the admin cleared
 * that cell" means.
 */
export async function saveFoodRoutine(
  input: FoodRoutineSaveInput,
  principal: ApiPrincipal,
  hostelId: Types.ObjectId,
) {
  await connectToDatabase();

  const monthEndItems = input.monthEndSpecial?.items ?? [];
  const routine = await FoodRoutineModel.findOneAndUpdate(
    { hostelId },
    {
      $set: {
        meals: input.meals.map((meal) => ({
          dayOfWeek: meal.dayOfWeek,
          items: meal.items,
          mealType: meal.mealType,
          note: meal.note ?? "",
        })),
        monthEndSpecial:
          monthEndItems.length > 0
            ? { items: monthEndItems, note: input.monthEndSpecial?.note ?? "" }
            : null,
        timings: input.timings,
        updatedBy: principal.userId,
      },
    },
    { new: true, upsert: true },
  ).lean<FoodRoutineRecord | null>();

  await AuditLogModel.create({
    action: "FOOD_ROUTINE_SAVED",
    actorId: principal.userId,
    entityId: hostelId.toString(),
    entityType: "FoodRoutine",
    hostelId,
    metadata: {
      meals: input.meals.length,
      monthEndSpecial: monthEndItems.length > 0,
    },
  });

  await publishResourceChange({
    hostelIds: [hostelId.toString()],
    topics: [REALTIME_TOPIC.FOOD],
  });

  /*
   * The routine is the kitchen's instructions, and it was just rewritten by
   * somebody who is not in the kitchen. The socket only reaches a cook who
   * already has the app open on that screen.
   */
  await notifyKitchenOfRoutineChange({
    actorUserId: principal.userId,
    hostelId,
  });

  return { routine: serializeRoutine(routine) };
}
