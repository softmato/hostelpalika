import { Types } from "mongoose";

import type { ApiPrincipal } from "@/lib/api-auth";
import { connectToDatabase } from "@/lib/db";
import { assertHostelAccess } from "@/lib/tenant";
import { AttendanceLogModel } from "@hostel/db/models/AttendanceLog";
import { FoodReadyLogModel } from "@hostel/db/models/FoodReadyLog";
import { FoodRoutineModel } from "@hostel/db/models/FoodRoutine";
import { ResidentModel } from "@hostel/db/models/Resident";
import { nepalMinuteOfDay, parseMealWindow } from "@hostel/shared/food/meal-window";

export class OperationsAnalyticsError extends Error {
  constructor(
    message: string,
    public errorCode = "OPERATIONS_ANALYTICS_ERROR",
    public status = 400,
  ) {
    super(message);
  }
}

const MEAL_TYPES = ["BREAKFAST", "LUNCH", "SNACKS", "DINNER"] as const;
type MealType = (typeof MEAL_TYPES)[number];

function normalizeObjectId(value: string, label = "id") {
  if (!Types.ObjectId.isValid(value)) {
    throw new OperationsAnalyticsError(`Invalid ${label}.`, "INVALID_OBJECT_ID", 422);
  }

  return new Types.ObjectId(value);
}

function resolveHostelId(principal: ApiPrincipal, requestedHostelId?: string) {
  if (requestedHostelId) {
    assertHostelAccess(principal, requestedHostelId);
    return normalizeObjectId(requestedHostelId, "hostel id");
  }

  if (principal.hostelIds.length === 1) {
    return normalizeObjectId(principal.hostelIds[0], "hostel id");
  }

  throw new OperationsAnalyticsError(
    "A hostelId is required for this report.",
    "HOSTEL_SCOPE_REQUIRED",
    422,
  );
}

/**
 * A hostel's serving time as minutes since midnight, or null when it cannot be
 * read as a clock.
 *
 * This used to be a local `^HH:MM$` regex, which matched almost nothing that is
 * actually in the database: `timings` is free text and the admin form seeds it
 * as `6:00 AM - 7:00 AM`, so every hostel that never edited the defaults had a
 * `null` target and therefore no delay figure at all — the report drew an
 * announcement count and a silent gap where the number it exists for goes.
 *
 * `parseMealWindow` is the same parse the cook portal's button gate uses, so
 * "when was this meal supposed to be served" has one answer across the product.
 */
function scheduledMinutes(timing?: string) {
  return parseMealWindow(timing)?.startMinute ?? null;
}

/**
 * Food service analytics (PHASES.md §5.1).
 *
 * "Delay" is measured against the hostel's own published timing for that meal,
 * because a 19:00 dinner is late in one hostel and early in another. A meal with
 * no published timing contributes an announcement count but no delay figure —
 * inventing a target would make the number meaningless.
 */
export async function getFoodAnalytics(
  principal: ApiPrincipal,
  options: { days?: number; hostelId?: string } = {},
) {
  await connectToDatabase();

  const hostelId = resolveHostelId(principal, options.hostelId);
  const days = Math.min(Math.max(options.days ?? 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000);

  const [logs, routine] = await Promise.all([
    FoodReadyLogModel.find({ announcedAt: { $gte: since }, hostelId })
      .sort({ announcedAt: -1 })
      .limit(2000)
      .lean<
        Array<{
          announcedAt: Date;
          announcedBy?: Types.ObjectId;
          deviceInfo?: Record<string, unknown>;
          mealType: MealType;
          notifiedCount?: number;
        }>
      >(),
    FoodRoutineModel.findOne({ hostelId }).lean<{
      timings?: Partial<Record<MealType, string>>;
    } | null>(),
  ]);

  const byMeal = MEAL_TYPES.map((mealType) => {
    const mealLogs = logs.filter((log) => log.mealType === mealType);
    const target = scheduledMinutes(routine?.timings?.[mealType]);
    // Kathmandu's clock, like the target. `getHours()` read UTC on the server,
    // so every meal looked ~6 hours early and "late" never fired.
    const announcedMinutes = mealLogs.map((log) => nepalMinuteOfDay(log.announcedAt));
    const delays =
      target === null ? [] : announcedMinutes.map((minutes) => minutes - target);

    return {
      announcements: mealLogs.length,
      averageDelayMinutes:
        delays.length > 0
          ? Math.round(delays.reduce((sum, value) => sum + value, 0) / delays.length)
          : null,
      averageReadyMinutes:
        announcedMinutes.length > 0
          ? Math.round(
              announcedMinutes.reduce((sum, value) => sum + value, 0) /
                announcedMinutes.length,
            )
          : null,
      lateCount: delays.filter((delay) => delay > 15).length,
      mealType,
      notified: mealLogs.reduce((sum, log) => sum + (log.notifiedCount ?? 0), 0),
      onTimeCount: delays.filter((delay) => delay <= 15).length,
      scheduledTiming: routine?.timings?.[mealType] ?? null,
    };
  });

  // Cook credentials are shared kitchen-wide, so "who announced" is only
  // meaningful at device granularity — that is what the fingerprint is for.
  const byDevice = new Map<string, { announcements: number; lastAt: Date }>();

  for (const log of logs) {
    const key =
      typeof log.deviceInfo?.fingerprint === "string"
        ? log.deviceInfo.fingerprint
        : "unidentified device";
    const entry = byDevice.get(key) ?? { announcements: 0, lastAt: log.announcedAt };

    entry.announcements += 1;

    if (log.announcedAt > entry.lastAt) {
      entry.lastAt = log.announcedAt;
    }

    byDevice.set(key, entry);
  }

  const measured = byMeal.filter((meal) => meal.averageDelayMinutes !== null);

  return {
    byDevice: [...byDevice.entries()]
      .map(([device, entry]) => ({
        announcements: entry.announcements,
        device,
        lastAnnouncedAt: entry.lastAt.toISOString(),
      }))
      .sort((a, b) => b.announcements - a.announcements),
    byMeal,
    summary: {
      averageDelayMinutes:
        measured.length > 0
          ? Math.round(
              measured.reduce((sum, meal) => sum + (meal.averageDelayMinutes ?? 0), 0) /
                measured.length,
            )
          : null,
      lateAnnouncements: byMeal.reduce((sum, meal) => sum + meal.lateCount, 0),
      onTimeAnnouncements: byMeal.reduce((sum, meal) => sum + meal.onTimeCount, 0),
      totalAnnouncements: logs.length,
      windowDays: days,
    },
  };
}

/**
 * Attendance patterns (PHASES.md §5.1, and the Phase 4 item deferred to here).
 *
 * Works from `AttendanceLog` zone rows only — the coordinates that produced them
 * were discarded at write time and are never available to a report.
 */
export async function getAttendanceAnalytics(
  principal: ApiPrincipal,
  options: { days?: number; hostelId?: string } = {},
) {
  await connectToDatabase();

  const hostelId = resolveHostelId(principal, options.hostelId);
  const days = Math.min(Math.max(options.days ?? 30, 1), 365);
  const since = new Date(Date.now() - days * 86_400_000);

  const rows = await AttendanceLogModel.aggregate<{
    _id: { residentId: Types.ObjectId; zone: string };
    count: number;
  }>([
    // `day` (not `recordedAt`) — one row per resident per day, and it is the
    // indexed field on `{ hostelId, zone, day }`.
    { $match: { day: { $gte: since }, hostelId } },
    {
      $group: {
        _id: { residentId: "$residentId", zone: "$zone" },
        count: { $sum: 1 },
      },
    },
  ]);

  const perResident = new Map<
    string,
    { inside: number; nearby: number; outside: number; total: number; unknown: number }
  >();

  for (const row of rows) {
    const key = row._id.residentId.toString();
    const entry = perResident.get(key) ?? {
      inside: 0,
      nearby: 0,
      outside: 0,
      total: 0,
      unknown: 0,
    };

    entry.total += row.count;

    if (row._id.zone === "INSIDE") entry.inside += row.count;
    else if (row._id.zone === "NEARBY") entry.nearby += row.count;
    else if (row._id.zone === "OUTSIDE") entry.outside += row.count;
    else entry.unknown += row.count;

    perResident.set(key, entry);
  }

  const residents = await ResidentModel.find({
    _id: { $in: [...perResident.keys()].map((id) => new Types.ObjectId(id)) },
  })
    .select("firstName lastName roomType")
    .lean<
      Array<{
        _id: Types.ObjectId;
        firstName: string;
        lastName: string;
        roomType?: string;
      }>
    >();
  const residentById = new Map(
    residents.map((resident) => [resident._id.toString(), resident]),
  );

  // "Present" counts INSIDE and NEARBY: a resident at the gate is not absent.
  const byResident = [...perResident.entries()]
    .map(([residentId, entry]) => {
      const resident = residentById.get(residentId);
      const present = entry.inside + entry.nearby;

      return {
        attendanceRate: entry.total > 0 ? present / entry.total : 0,
        inside: entry.inside,
        name: resident
          ? `${resident.firstName} ${resident.lastName}`.trim()
          : "Former resident",
        nearby: entry.nearby,
        outside: entry.outside,
        residentId,
        roomType: resident?.roomType ?? "",
        total: entry.total,
        unknown: entry.unknown,
      };
    })
    .sort((a, b) => a.attendanceRate - b.attendanceRate);

  const totals = [...perResident.values()].reduce(
    (sum, entry) => ({
      inside: sum.inside + entry.inside,
      nearby: sum.nearby + entry.nearby,
      outside: sum.outside + entry.outside,
      total: sum.total + entry.total,
      unknown: sum.unknown + entry.unknown,
    }),
    { inside: 0, nearby: 0, outside: 0, total: 0, unknown: 0 },
  );

  return {
    byResident,
    // Worst attendance first, so the follow-up list is the top of the table.
    frequentlyAbsent: byResident
      .filter((entry) => entry.total >= 5 && entry.attendanceRate < 0.5)
      .slice(0, 20),
    summary: {
      averageAttendanceRate:
        totals.total > 0 ? (totals.inside + totals.nearby) / totals.total : 0,
      pings: totals.total,
      residentsTracked: perResident.size,
      windowDays: days,
      zones: {
        inside: totals.inside,
        nearby: totals.nearby,
        outside: totals.outside,
        unknown: totals.unknown,
      },
    },
  };
}
